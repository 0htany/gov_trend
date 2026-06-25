/**
 * 省庁審議会ウォッチシステム - 3段階パイプライン版
 *
 * 処理を3段階に分離:
 *   第1段階（収集）: ページ取得 → HTMLパース → 審議会フィルタ → シート書き込み（基本情報のみ）
 *   第2段階（分析）: URL先の本文取得 → Claude APIで要約・キーワード抽出・グループ判定 → シート書き戻し
 *   第3段階（通知）: 分析済み＋未通知の行を Slack通知 → 通知済みフラグ更新
 *
 * 使用方法:
 * 1. Spreadsheet → 拡張機能 → Apps Script
 * 2. このコードを貼り付け
 * 3. initialSetupWithSlackAndTriggers() を実行
 * 4. 設定シートに SLACK_WEBHOOK_URL と CLAUDE_API_KEY を設定
 */

// ==================== 実行パラメータ（調整ポイント） ====================

// 省庁ごとの最大処理件数（新着候補の上限）
const MAX_ITEMS_PER_TARGET = 50;

// Claude分析時にURL先から取り出すテキスト上限（文字数）
const BODY_TEXT_MAX_CHARS = 30000;

// 待機（ミリ秒）※タイムアウト回避のため最小限に
const SLEEP_BETWEEN_TARGETS_MS = 200;
const SLEEP_BETWEEN_SLACK_POSTS_MS = 300;
const SLEEP_BETWEEN_ANALYSIS_MS = 500;

// ==================== スクレイピング対象ページ設定 ====================

// 経産省：審議会/研究会ページ（HTML）を監視
const SCRAPE_TARGETS_METI = [
  {
    name: '経産省（審議会）',
    url: 'https://www.meti.go.jp/shingikai/index.html',
    baseUrl: 'https://www.meti.go.jp',
    parser: 'parseMETI_SHINGIKAI_INDEX',
    category: 'council',
    isMetiHtml: true
  },
  {
    name: '経産省（審議会・報告書）',
    url: 'https://www.meti.go.jp/shingikai/index_report.html',
    baseUrl: 'https://www.meti.go.jp',
    parser: 'parseMETI_SHINGIKAI_INDEX',
    category: 'council',
    isMetiHtml: true
  },
  {
    name: '経産省（審議会・リンク）',
    url: 'https://www.meti.go.jp/shingikai/index_links.html',
    baseUrl: 'https://www.meti.go.jp',
    parser: 'parseMETI_SHINGIKAI_INDEX',
    category: 'council',
    isMetiHtml: true
  }
];

// その他省庁
const SCRAPE_TARGETS_OTHERS = [
  {
    name: 'デジタル庁',
    url: 'https://www.digital.go.jp/news?category=146',
    baseUrl: 'https://www.digital.go.jp',
    parser: 'parseDigital'
  },
  {
    name: '金融庁',
    url: 'https://www.fsa.go.jp/news/',
    baseUrl: 'https://www.fsa.go.jp',
    parser: 'parseFSA'
  },
  {
    name: '総務省',
    url: 'https://www.soumu.go.jp/menu_news/s-news/index.html',
    baseUrl: 'https://www.soumu.go.jp',
    parser: 'parseSoumu',
    encoding: 'Shift_JIS'
  },
  {
    name: '内閣府',
    url: 'https://www.cao.go.jp/press/houdou.html',
    baseUrl: 'https://www.cao.go.jp',
    parser: 'parseCao'
  },
  {
    name: '防衛省',
    url: 'https://www.mod.go.jp/j/press/news/',
    baseUrl: 'https://www.mod.go.jp',
    parser: 'parseMOD'
  }
];

// ==================== キーワード ====================

// 審議会関連のキーワード（第1段階のフィルタ用）
const COUNCIL_KEYWORDS = [
  '審議会', '研究会', 'ワーキンググループ', 'WG', '懇談会',
  '検討会', '有識者会議', '専門家会議', '委員会', '部会',
  '分科会', '小委員会', '作業部会', '協議会', '会議'
];

// GMO関連のキーワード（第2段階のClaude分析プロンプト用）
//
// グループ1: フィジカルAI（AI×ロボティクス）
// グループ2: サイバーセキュリティ
// グループ3: GPU/データセンター基盤
// グループ4: EC/決済
// グループ5: 防衛×テクノロジー（AI・サイバー・ロボットが寄与する防衛テーマ）
const GMO_KEYWORDS = {
  1: ['フィジカルAI', 'ロボティクス', 'ロボット', '生成AI', '機械学習',
      'ディープラーニング', '自律制御', '産業用ロボット', 'マニピュレータ',
      'ドローン', '自動運転', 'AIロボット'],
  2: ['サイバーセキュリティ', 'サイバー攻撃', 'サイバー防衛',
      '情報セキュリティ', 'ランサムウェア', 'マルウェア', 'フィッシング',
      'CSIRT', 'SOC', '脆弱性', 'インシデント対応', 'ゼロトラスト',
      'セキュリティインシデント'],
  3: ['GPU', 'データセンター', 'GPUホスティング', 'GPUクラウド',
      '半導体', 'HPC', '計算基盤', 'スーパーコンピュータ',
      'AI基盤', 'コロケーション', 'NVIDIA', 'AI半導体'],
  4: ['イーコマース', '電子商取引', '決済', 'キャッシュレス',
      'フィンテック', '電子決済', 'ネット通販', 'オンラインショッピング',
      'インターネット取引', 'ネット取引', '支払手段', '支払い手段'],
  5: ['防衛AI', '防衛ロボット', '無人機', '軍事AI', '防衛サイバー',
      'サイバー防衛', '自律型無人機', '無人航空機', 'UAV', 'UGV',
      '防衛装備', 'デュアルユース', '安全保障技術', '防衛DX',
      '防衛イノベーション', '宇宙安全保障', '電子戦', '情報戦']
};

// グループ3の中で「電力メイン」と見なすキーワード
// これらだけにマッチした場合はSlack通知をスキップ（通知済み扱い）
const POWER_ONLY_KEYWORDS = [
  '電力', '火力', '水力', '原子力', '再生可能エネルギー',
  '太陽光', '風力', '地熱', 'バイオマス', '蓄電', '送電',
  '配電', '電気事業', '発電'
];

// ==================== ページ取得（リトライ機能付き） ====================

function fetchPage(url, encoding, maxRetries) {
  const retries = (typeof maxRetries === 'number') ? maxRetries : 3;
  const retryDelay = 1500;
  const REQUEST_TIMEOUT_MS = 20000;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      Logger.log('取得試行 ' + attempt + '/' + retries + ': ' + url);

      const response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': 'GoogleAppsScript',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja'
        }
      });

      const code = response.getResponseCode();
      if (code === 200) {
        if (encoding && encoding !== 'UTF-8') return response.getContentText(encoding);
        return response.getContentText('UTF-8');
      }

      Logger.log('HTTP ' + code + ': ' + url);

    } catch (e) {
      Logger.log('試行 ' + attempt + ' エラー: ' + e.message);
      if (attempt < retries) Utilities.sleep(retryDelay);
    }
  }

  return null;
}

/**
 * 経産省HTMLを「プロキシ→直取得→CacheService短期キャッシュ」で取得する
 *
 * キャッシュ戦略:
 * - ScriptProperties にはHTMLを保存しない（容量上限 500KB を超えるため）
 * - CacheService（最大100KB/key, TTL最大6時間）に短期キャッシュを保存
 * - breakerKeyなど小さい値のみ ScriptProperties に保存
 */
function fetchMETIHtmlResilient_(url, encoding) {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'METI_HTML_' + generateId(url);
  const breakerKey = 'METI_DIRECT_BLOCK_UNTIL';
  const now = Date.now();

  const blockUntil = Number(props.getProperty(breakerKey) || 0);
  const directAllowed = now >= blockUntil;

  // 1) プロキシ優先
  const proxyUrl = 'https://r.jina.ai/' + url;
  Logger.log('経産省HTML まずプロキシ取得: ' + proxyUrl);

  let html = fetchPage(proxyUrl, encoding || 'UTF-8', 1);
  if (html) {
    putCacheChunked_(cache, cacheKey, html);
    return { html, source: 'proxy' };
  }

  // 2) 直アクセス
  if (directAllowed) {
    Logger.log('経産省HTML プロキシ失敗 → 直取得にフォールバック: ' + url);
    html = fetchPage(url, encoding || 'UTF-8', 1);
    if (html) {
      putCacheChunked_(cache, cacheKey, html);
      return { html, source: 'direct' };
    }
    props.setProperty(breakerKey, String(now + 12 * 60 * 60 * 1000));
  } else {
    Logger.log('経産省HTML 直取得はブロック中（blockUntil=' + new Date(blockUntil).toISOString() + '）');
  }

  // 3) CacheService から短期キャッシュ復元
  const cached = getCacheChunked_(cache, cacheKey);
  if (cached) {
    Logger.log('経産省HTML 取得失敗 → CacheServiceキャッシュ使用: ' + url);
    return { html: cached, source: 'cache' };
  }

  return { html: null, source: 'none' };
}

// ==================== CacheService チャンク分割ヘルパー ====================

// CacheService は 1キーあたり最大 100KB。大きいHTMLを分割して保存する。
const CACHE_CHUNK_SIZE = 90000; // 安全マージンを取って90KB
const CACHE_TTL_SEC = 21600;    // 6時間（CacheServiceの最大）

/**
 * 大きな文字列を分割して CacheService に保存
 */
function putCacheChunked_(cache, key, value) {
  try {
    const str = String(value);
    const totalChunks = Math.ceil(str.length / CACHE_CHUNK_SIZE);

    // メタ情報を保存
    cache.put(key + '_meta', String(totalChunks), CACHE_TTL_SEC);

    // チャンクを保存
    for (let i = 0; i < totalChunks; i++) {
      const chunk = str.substring(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE);
      cache.put(key + '_' + i, chunk, CACHE_TTL_SEC);
    }
  } catch (e) {
    Logger.log('[putCacheChunked_] キャッシュ保存失敗: ' + e.message);
  }
}

/**
 * 分割保存された文字列を CacheService から復元
 */
function getCacheChunked_(cache, key) {
  try {
    const metaStr = cache.get(key + '_meta');
    if (!metaStr) return null;

    const totalChunks = Number(metaStr);
    if (!totalChunks || totalChunks <= 0) return null;

    const parts = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = cache.get(key + '_' + i);
      if (chunk === null) return null; // 一部でも欠けたら無効
      parts.push(chunk);
    }

    return parts.join('');
  } catch (e) {
    Logger.log('[getCacheChunked_] キャッシュ取得失敗: ' + e.message);
    return null;
  }
}

/**
 * ScriptProperties に残っている METI_HTML_ 系のプロパティを一括削除する
 * （容量逼迫時に手動実行してください）
 */
function clearMetiHtmlCacheProperties() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let count = 0;

  for (const key of Object.keys(all)) {
    if (key.startsWith('METI_HTML_')) {
      props.deleteProperty(key);
      count++;
    }
  }

  Logger.log('METI_HTML_ プロパティを ' + count + ' 件削除しました');
  return count;
}

// ==================== パーサー ====================

function parseItems(html, target) {
  const baseUrl = target.baseUrl || '';

  switch (target.parser) {
    case 'parseMETI_SHINGIKAI_INDEX':
      return parseMETI_SHINGIKAI_INDEX(html, baseUrl);
    case 'parseDigital':
      return parseDigital(html, baseUrl);
    case 'parseFSA':
      return parseFSA(html, baseUrl);
    case 'parseSoumu':
      return parseSoumu(html, baseUrl);
    case 'parseCao':
      return parseCao(html, baseUrl);
    case 'parseMOD':
      return parseMOD(html, baseUrl);
    default:
      return parseGeneric(html, baseUrl);
  }
}

function parseMETI_SHINGIKAI_INDEX(html, baseUrl) {
  const items = [];
  const text = String(html || '');

  function guessDateNear_(s, idx) {
    const near = s.substring(Math.max(0, idx - 120), Math.min(s.length, idx + 240));
    const m = near.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) return new Date();
    const y = m[1];
    const mo = String(m[2]).padStart(2, '0');
    const d = String(m[3]).padStart(2, '0');
    return new Date(y + '-' + mo + '-' + d);
  }

  // 1) HTMLの<a href="...">text</a>
  const cleaned = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  let m;

  const aPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = aPattern.exec(cleaned)) !== null) {
    let url = m[1];
    let title = m[2].replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' ');
    if (!title || title.length < 4) continue;

    if (url.startsWith('/')) url = baseUrl + url;
    else if (!url.startsWith('http')) url = baseUrl + '/shingikai/' + url.replace(/^\.\//, '');

    if (!url.includes('meti.go.jp')) continue;

    items.push({ title, url, date: guessDateNear_(cleaned, m.index), description: '' });
  }

  // 2) Markdownリンク: [title](url)
  const mdPattern = /\[([^\]]{4,200})\]\((https?:\/\/[^\s)]+)\)/g;
  while ((m = mdPattern.exec(text)) !== null) {
    const title = m[1].trim().replace(/\s+/g, ' ');
    const url = m[2];

    if (!url.includes('meti.go.jp')) continue;
    if (!url.includes('/shingikai/')) continue;

    items.push({ title, url, date: guessDateNear_(text, m.index), description: '' });
  }

  // 3) 生URL
  const urlPattern = /(https?:\/\/www\.meti\.go\.jp\/shingikai\/[^\s"'<>]+)\b/g;
  while ((m = urlPattern.exec(text)) !== null) {
    const url = m[1];
    const title = '経産省 審議会リンク: ' + url.split('/').slice(-1)[0];
    items.push({ title, url, date: guessDateNear_(text, m.index), description: '' });
  }

  // URLで重複排除
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    uniq.push(it);
  }

  return uniq;
}

function parseDigital(html, baseUrl) {
  const items = [];

  const mdPattern = /\[([^\]]+?)[\s\n]+会議等[\s\n]+(\d{4})年(\d{1,2})月(\d{1,2})日\]\(([^)]+)\)/g;
  let match;
  while ((match = mdPattern.exec(html)) !== null) {
    const title = match[1].trim().replace(/\s+/g, ' ');
    const year = match[2];
    const month = match[3].padStart(2, '0');
    const day = match[4].padStart(2, '0');
    let url = match[5];

    if (url.startsWith('/')) url = baseUrl + url;

    if (title.length > 5) {
      items.push({ title, url, date: new Date(year + '-' + month + '-' + day), description: '' });
    }
  }

  if (items.length === 0) {
    const liPattern = /<li[^>]*>[\s\S]*?<a[^>]+href="(\/councils[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(\d{4})年(\d{1,2})月(\d{1,2})日/gi;
    while ((match = liPattern.exec(html)) !== null) {
      let url = match[1];
      const title = match[2].replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' ');
      const year = match[3];
      const month = match[4].padStart(2, '0');
      const day = match[5].padStart(2, '0');

      if (url.startsWith('/')) url = baseUrl + url;

      if (title.length > 5) {
        items.push({ title, url, date: new Date(year + '-' + month + '-' + day), description: '' });
      }
    }
  }

  if (items.length === 0) {
    const htmlPattern = /<a[^>]+href="(\/councils[^"]*)"[^>]*>([^<]+)<\/a>/gi;
    while ((match = htmlPattern.exec(html)) !== null) {
      let url = match[1];
      const title = match[2].trim();
      if (url.startsWith('/')) url = baseUrl + url;
      if (title.length > 5) {
        items.push({ title, url, date: new Date(), description: '' });
      }
    }
  }

  return items;
}

function parseFSA(html, baseUrl) {
  const items = [];
  const normalizedHtml = html.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));

  const pattern = /令和(\d+)年(\d{1,2})月(\d{1,2})日[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = pattern.exec(normalizedHtml)) !== null) {
    const reiwYear = parseInt(match[1], 10);
    const year = reiwYear + 2018;
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    let url = match[4];
    const title = match[5].trim();

    if (url.startsWith('/')) url = baseUrl + url;

    items.push({ title, url, date: new Date(year + '-' + month + '-' + day), description: '' });
  }

  return items;
}

function parseSoumu(html, baseUrl) {
  const items = [];
  const pattern = /(\d{4})年(\d{1,2})月(\d{1,2})日[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    let url = match[4];
    const title = match[5].trim();

    if (url.startsWith('/')) url = baseUrl + url;
    if (title.length < 5) continue;

    items.push({ title, url, date: new Date(year + '-' + month + '-' + day), description: '' });
  }

  return items;
}

function parseCao(html, baseUrl) {
  const items = [];
  const yearMatch = html.match(/報道発表資料\s*(\d{4})年/);
  const currentYear = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

  const pattern = /(\d{1,2})月(\d{1,2})日[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const month = match[1].padStart(2, '0');
    const day = match[2].padStart(2, '0');
    let url = match[3];
    const title = match[4].trim();

    if (url.includes('e-gov.go.jp') || url.includes('survey.gov-online')) continue;

    if (url.startsWith('/')) url = baseUrl + url;
    else if (url.startsWith('http')) { /* noop */ }
    else url = baseUrl + '/' + url;

    if (title.length < 5) continue;

    items.push({ title, url, date: new Date(currentYear + '-' + month + '-' + day), description: '' });
  }

  return items;
}

function parseMOD(html, baseUrl) {
  const items = [];
  const pattern = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].trim();

    if (!url.startsWith('/j/') && !url.startsWith('https://www.mod.go.jp/j/')) continue;
    if (url.startsWith('/')) url = baseUrl + url;

    if (title.length < 10 || title === '印刷用') continue;

    items.push({ title, url, date: new Date(), description: '' });
  }

  return items;
}

function parseGeneric(html, baseUrl) {
  const items = [];
  const pattern = /<a[^>]+href="([^"]+)"[^>]*>([^<]{10,200})<\/a>/gi;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].trim();

    if (url.startsWith('/')) url = baseUrl + url;

    if (COUNCIL_KEYWORDS.some(kw => title.includes(kw))) {
      items.push({ title, url, date: new Date(), description: '' });
    }
  }

  return items;
}

// ==================== キーワード処理 ====================

function isCouncilRelated(text) {
  return COUNCIL_KEYWORDS.some(keyword => text.includes(keyword));
}

/**
 * 「電力メイン」判定: グループ3だけ かつ キーワードが全て電力系のみ → true
 *
 * 例:
 *  groups=["3"], keywords=["電力"]               → true（通知スキップ）
 *  groups=["3"], keywords=["電力", "データセンター"] → false（DC含むので通知する）
 *  groups=["1","3"], keywords=["AI", "電力"]      → false（グループ1もあるので通知する）
 *  groups=["3"], keywords=["GPU"]                → false（電力系でないので通知する）
 */
function isPowerOnlyItem_(groups, keywords) {
  if (!groups || !keywords || keywords.length === 0) return false;

  // グループ3以外が含まれている → 通知対象
  const safeGroups = groups.map(g => String(g).trim());
  if (safeGroups.some(g => g !== '3')) return false;

  // グループ3のみの場合: キーワードが全てPOWER_ONLY_KEYWORDSに含まれるか
  const normalizedPower = POWER_ONLY_KEYWORDS.map(k => k.toLowerCase());

  for (const kw of keywords) {
    const lower = String(kw).toLowerCase();
    if (!normalizedPower.includes(lower)) {
      return false; // 電力系でないキーワードが1つでもあれば通知対象
    }
  }

  return true; // 全キーワードが電力系 → 通知スキップ
}

// ==================== ユーティリティ ====================

function generateId(url) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, url)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2))
    .join('');
}

function getExistingIds(sheet) {
  const ids = new Set();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) ids.add(data[i][0]);
  }
  return ids;
}

function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function getSettingValue(settingsSheet, key) {
  const data = settingsSheet.getDataRange().getValues();
  for (const row of data) {
    if (row[0] === key) return row[1];
  }
  return null;
}

function getSlackWebhookUrl(settingsSheet) {
  return getSettingValue(settingsSheet, 'SLACK_WEBHOOK_URL');
}

function getApiKey(settingsSheet) {
  return getSettingValue(settingsSheet, 'CLAUDE_API_KEY');
}

function updateLastCheckDate(settingsSheet) {
  const data = settingsSheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === 'LAST_CHECK_DATE') {
      settingsSheet.getRange(i + 1, 2).setValue(new Date());
      return;
    }
  }
}

function formatDateForSlack(date) {
  if (!date) return '';
  if (date instanceof Date) {
    return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd');
  }
  return String(date);
}

function normalizeGroupsFromCell_(cellValue) {
  if (cellValue === null || cellValue === undefined) return [];
  if (cellValue instanceof Date) return [];

  let s = String(cellValue).trim();
  if (!s) return [];

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return [];

  s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[、，\s;/|]+/g, ',');

  if (/^\d{4},\d{1,2},\d{1,2}$/.test(s)) return [];

  return s
    .split(',')
    .map(x => x.trim())
    .filter(x => /^[1-5]$/.test(x));
}

function extractTextFromHtml_(html, maxChars) {
  const s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

  if (!maxChars) return s;
  return s.length > maxChars ? s.substring(0, maxChars) : s;
}

// ==================== 第2段階: Claude API（分析） ====================

/**
 * GMO_KEYWORDSをプロンプト用テキストに変換
 */
function buildGmoKeywordsPromptText_() {
  const lines = [];
  for (const [group, keywords] of Object.entries(GMO_KEYWORDS)) {
    const groupNames = { '1': 'フィジカルAI/ロボティクス', '2': 'サイバーセキュリティ', '3': 'GPU/データセンター基盤', '4': 'EC/決済', '5': '防衛×テクノロジー' };
    lines.push('グループ' + group + '（' + (groupNames[group] || '') + '）: ' + keywords.join(', '));
  }
  return lines.join('\n');
}

/**
 * URL先の本文テキストを取得するヘルパー
 * 経産省はプロキシ優先の耐障害取得、他省庁は通常取得
 */
function fetchBodyText_(url, ministry) {
  if (!url) return null;

  // PDFは現在対応外
  if (/\.pdf(\?|$)/i.test(url)) {
    Logger.log('[fetchBodyText_] PDF はスキップ: ' + url);
    return null;
  }

  let html = null;

  if (String(ministry).startsWith('経産省')) {
    const result = fetchMETIHtmlResilient_(url, 'UTF-8');
    html = result ? result.html : null;
  } else {
    html = fetchPage(url, null, 2);
  }

  if (!html) return null;
  return extractTextFromHtml_(html, BODY_TEXT_MAX_CHARS);
}

/**
 * Claude APIでURL先の内容を分析（要約・キーワード・グループを一括判定）
 *
 * @param {string} apiKey - Claude APIキー
 * @param {string} title - 記事タイトル
 * @param {string} ministry - 省庁名
 * @param {string} bodyText - URL先の本文テキスト
 * @returns {{ summary: string, keywords: string[], groups: string[] }}
 */
function analyzeWithClaude(apiKey, title, ministry, bodyText) {
  if (!apiKey) {
    Logger.log('[analyzeWithClaude] APIキーなし → スキップ');
    return null;
  }

  const keywordsText = buildGmoKeywordsPromptText_();

  // 本文がない場合はタイトルのみで分析
  const contentSection = bodyText
    ? '本文:\n' + truncateText(bodyText, 8000)
    : '（本文取得不可。タイトルのみで判断してください）';

  const prompt = '以下の政府省庁ページの内容を分析してください。\n\n'
    + '省庁: ' + ministry + '\n'
    + 'タイトル: ' + title + '\n'
    + contentSection + '\n\n'
    + '以下の形式のJSONのみで回答してください（余計なテキストは不要）:\n'
    + '{\n'
    + '  "summary": "内容を100文字程度の日本語で要約した文",\n'
    + '  "keywords": ["該当するキーワードの配列"],\n'
    + '  "groups": ["1", "2"]  ← 該当するグループ番号だけ。取りうる値は "1","2","3","4","5" の5種類のみ\n'
    + '}\n\n'
    + '回答例（該当キーワードがある場合）:\n'
    + '{"summary": "AIを活用した...", "keywords": ["フィジカルAI", "半導体"], "groups": ["1", "3"]}\n\n'
    + '回答例（防衛×テクノロジーの場合）:\n'
    + '{"summary": "防衛省が無人機のAI活用を...", "keywords": ["無人機", "防衛AI"], "groups": ["5"]}\n\n'
    + '回答例（該当キーワードがない場合）:\n'
    + '{"summary": "環境規制に関する...", "keywords": [], "groups": []}\n\n'
    + 'キーワード候補（グループ別）:\n'
    + keywordsText + '\n\n'
    + '注意:\n'
    + '- keywordsには上記候補リストの中から、内容に明確に関連するものだけを入れてください\n'
    + '- groupsにはkeywordsが属するグループ番号を入れてください。値は "1","2","3","4","5" のいずれかのみです。年号や他の数字を入れないでください\n'
    + '- どのキーワードにも明確に該当しない場合は、keywordsとgroupsを必ず空配列 [] にしてください。無理に当てはめないでください\n'
    + '- 「なんとなく関連しそう」程度ではキーワードに含めないでください。内容の主題として扱われている場合のみ含めてください\n'
    + '- summaryは必ず記入してください';

  try {
    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      Logger.log('[analyzeWithClaude] API エラー: HTTP ' + code);
      return null;
    }

    const result = JSON.parse(response.getContentText());
    if (!result.content || !result.content[0] || !result.content[0].text) {
      Logger.log('[analyzeWithClaude] レスポンス形式不正');
      return null;
    }

    const text = result.content[0].text.trim();

    // JSONを抽出（```json ... ``` で囲まれている場合も対応）
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    // グループ番号を安全化（配列でない場合も対応）
    let rawGroups = parsed.groups || [];
    if (!Array.isArray(rawGroups)) {
      // "1, 2, 3" のような文字列が返された場合を分割
      rawGroups = String(rawGroups).split(/[,\s]+/);
    }
    const safeGroups = rawGroups
      .map(g => String(g).trim())
      .filter(g => /^[1-5]$/.test(g));

    return {
      summary: truncateText(String(parsed.summary || ''), 200),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      groups: Array.from(new Set(safeGroups))
    };

  } catch (e) {
    Logger.log('[analyzeWithClaude] 例外: ' + e.message);
    return null;
  }
}

// ==================== シート作成 ====================

function createDataSheet(ss) {
  const sheet = ss.insertSheet('新着情報');
  sheet.appendRow([
    'ID', '取得日時', '省庁', 'タイトル', 'URL',
    '公開日', 'キーワード', 'グループ', '要約', 'Slack通知済'
  ]);

  const headerRange = sheet.getRange(1, 1, 1, 10);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4a86e8');
  headerRange.setFontColor('white');

  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(3, 70);
  sheet.setColumnWidth(4, 300);
  sheet.setColumnWidth(5, 200);
  sheet.setColumnWidth(6, 90);
  sheet.setColumnWidth(7, 150);
  sheet.setColumnWidth(8, 60);
  sheet.setColumnWidth(9, 300);
  sheet.setColumnWidth(10, 80);

  return sheet;
}

function createSettingsSheet(ss) {
  const sheet = ss.insertSheet('設定');
  sheet.appendRow(['設定項目', '値', '説明']);
  sheet.appendRow(['CLAUDE_API_KEY', '', 'Claude APIキー（第2段階の分析機能用、必須）']);
  sheet.appendRow(['SLACK_WEBHOOK_URL', '', 'Slack Workflow Webhook URL']);
  sheet.appendRow(['LAST_CHECK_DATE', '', '最終チェック日時（自動更新）']);

  const headerRange = sheet.getRange(1, 1, 1, 3);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#f3f3f3');

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 400);
  sheet.setColumnWidth(3, 250);

  return sheet;
}

function createMentionSheet(ss) {
  const sheet = ss.insertSheet('メンション設定');

  sheet.appendRow(['キー', 'SlackユーザーID（Uxxxx）']);
  sheet.appendRow(['group_1', '']);     // フィジカルAI/ロボティクス
  sheet.appendRow(['group_2', '']);     // サイバーセキュリティ
  sheet.appendRow(['group_3', '']);     // GPU/データセンター基盤
  sheet.appendRow(['group_4', '']);     // EC/決済
  sheet.appendRow(['group_5', '']);     // 防衛×テクノロジー
  sheet.appendRow(['multi', '']);       // 複数カテゴリ
  sheet.appendRow(['default', '']);     // 該当なし

  sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 240);

  return sheet;
}

function getMentionSettings(ss) {
  const sheet = ss.getSheetByName('メンション設定');
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  const map = {};

  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || '').trim();
    const user = String(data[i][1] || '').trim();

    if (!key) continue;

    if (user && /^U[A-Z0-9]+$/.test(user)) {
      map[key] = user;
    } else {
      map[key] = '';
    }
  }

  return map;
}

// ==================== Slack通知 ====================

function buildMentionsPayload_(groups, mentionSettings) {
  const groupList = Array.from(
    new Set((groups || []).map(g => String(g).trim()))
  ).filter(g => /^[1-5]$/.test(g));

  let mention_user = '';
  let mention_channel = '';

  if (groupList.length === 1) {
    mention_user = mentionSettings['group_' + groupList[0]] || '';
  } else if (groupList.length >= 2) {
    mention_user = mentionSettings['multi'] || '';
    mention_channel = '<!channel>';
  } else {
    // グループなし → メンションなし
    mention_user = '';
  }

  return {
    mention_user: String(mention_user || ''),
    mention_channel: String(mention_channel || '')
  };
}

function postToSlackWorkflow(webhookUrl, item, mentionSettings) {
  const safeSummary = truncateText(String(item.summary || ''), 600);

  const payload = {
    ministry: String(item.ministry || ''),
    title: String(item.title || ''),
    url: String(item.url || ''),
    pub_date: String(formatDateForSlack(item.pubDate) || ''),
    keywords: String(item.keywords || ''),
    group: String(item.groups ? item.groups.join(', ') : ''),
    summary: safeSummary
  };

  const mentionVars = buildMentionsPayload_(item.groups, mentionSettings);
  payload.mention_user = String(mentionVars.mention_user || '');
  payload.mention_channel = String(mentionVars.mention_channel || '');

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(webhookUrl, options);
  const code = response.getResponseCode();

  if (code !== 200 && code !== 202) {
    Logger.log('[Slack] payload=' + JSON.stringify(payload));
    throw new Error('Webhook エラー (' + code + '): ' + response.getContentText());
  }
}

// ====================================================================
//  第1段階: 収集（ページ取得→パース→審議会フィルタ→シート書き込み）
// ====================================================================

/**
 * 単一ターゲットを処理して、新着行をシートに追加する（第1段階用・簡略版）
 * - 審議会フィルタ＋重複チェックのみ
 * - 書き込み: ID, 日時, 省庁, タイトル, URL, 公開日（キーワード/グループ/要約/通知済みは空）
 */
function processOneTarget(target, dataSheet, existingIds) {
  Logger.log('------------------------------');
  Logger.log('[processOneTarget] start: ' + target.name);
  Logger.log('[processOneTarget] url  : ' + target.url);

  // 1) Fetch
  const tFetch0 = new Date();
  let fetched = null;
  if (target.isMetiHtml === true) {
    fetched = fetchMETIHtmlResilient_(target.url, target.encoding || 'UTF-8');
  } else {
    const html0 = fetchPage(target.url, target.encoding);
    fetched = { html: html0, source: 'normal' };
  }

  const html = fetched ? fetched.html : null;
  const tFetch1 = new Date();

  if (target.isMetiHtml === true) {
    Logger.log('[processOneTarget] METI fetch source: ' + (fetched ? fetched.source : 'none'));
  }
  Logger.log('[processOneTarget] fetch(ms): ' + (tFetch1 - tFetch0));

  if (!html) {
    Logger.log('[processOneTarget] FAIL: fetch returned null');
    return 0;
  }

  Logger.log('[processOneTarget] fetched chars: ' + String(html).length);

  // 2) Parse
  const tParse0 = new Date();
  const items = parseItems(html, target);
  const tParse1 = new Date();
  Logger.log('[processOneTarget] parse(ms): ' + (tParse1 - tParse0) + ' / items=' + (items ? items.length : 0));

  if (!items || items.length === 0) {
    Logger.log('[processOneTarget] no items');
    return 0;
  }

  // 3) 件数制限
  const limitedItems = items.slice(0, MAX_ITEMS_PER_TARGET);

  // 4) フィルタ＋収集ループ
  const rowsToAppend = [];
  let councilSkipped = 0;
  let dupSkipped = 0;

  for (const item of limitedItems) {
    if (!item || !item.title || !item.url) continue;

    // 審議会関連フィルタ（経産省 shingikai は緩める）
    if (!isCouncilRelated(item.title) && target.isMetiHtml !== true) {
      councilSkipped++;
      continue;
    }

    // 重複チェック
    const itemId = generateId(item.url);
    if (existingIds.has(itemId)) {
      dupSkipped++;
      continue;
    }

    const pubDate = (item.date instanceof Date) ? item.date : new Date();
    const shortTitle = truncateText(item.title, 80);

    // 第1段階: 基本6列のみ書き込み（キーワード/グループ/要約/通知済みは空）
    rowsToAppend.push([
      itemId,
      new Date(),
      target.name,
      shortTitle,
      item.url,
      pubDate,
      '',    // キーワード（第2段階で記入）
      '',    // グループ（第2段階で記入）
      '',    // 要約（第2段階で記入）
      false  // Slack通知済（第3段階で更新）
    ]);

    existingIds.add(itemId);
  }

  // 5) まとめて書き込み
  if (rowsToAppend.length > 0) {
    const startRow = dataSheet.getLastRow() + 1;
    dataSheet.getRange(startRow, 1, rowsToAppend.length, 10).setValues(rowsToAppend);
    Logger.log('[processOneTarget] wrote rows=' + rowsToAppend.length + ' startRow=' + startRow);
  }

  Logger.log('[processOneTarget] councilSkip=' + councilSkipped + ' dupSkip=' + dupSkipped + ' appended=' + rowsToAppend.length);
  Logger.log('[processOneTarget] end: ' + target.name);
  Logger.log('------------------------------');

  return rowsToAppend.length;
}

/**
 * 第1段階: 経産省の新着情報を収集
 */
function collectMETI() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName('新着情報') || createDataSheet(ss);
  const settingsSheet = ss.getSheetByName('設定') || createSettingsSheet(ss);
  const existingIds = getExistingIds(dataSheet);

  Logger.log('==== 第1段階: 経産省 収集開始 ====');

  let totalNew = 0;

  for (const target of SCRAPE_TARGETS_METI) {
    try {
      Logger.log('--- ' + target.name + ' ---');
      const newCount = processOneTarget(target, dataSheet, existingIds);
      totalNew += newCount;
    } catch (e) {
      Logger.log(target.name + ' 処理エラー: ' + e.message);
    }

    Utilities.sleep(SLEEP_BETWEEN_TARGETS_MS);
  }

  updateLastCheckDate(settingsSheet);

  Logger.log('==== 第1段階: 経産省 完了: ' + totalNew + '件 ====');
  return totalNew;
}

/**
 * 第1段階: 経産省以外の新着情報を収集
 */
function collectOtherMinistries() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName('新着情報') || createDataSheet(ss);
  const settingsSheet = ss.getSheetByName('設定') || createSettingsSheet(ss);
  const existingIds = getExistingIds(dataSheet);

  Logger.log('==== 第1段階: 他省庁 収集開始 ====');

  let totalNew = 0;

  for (const target of SCRAPE_TARGETS_OTHERS) {
    try {
      Logger.log('--- ' + target.name + ' ---');
      const newCount = processOneTarget(target, dataSheet, existingIds);
      totalNew += newCount;
    } catch (e) {
      Logger.log(target.name + ' 処理エラー: ' + e.message);
    }

    Utilities.sleep(SLEEP_BETWEEN_TARGETS_MS);
  }

  updateLastCheckDate(settingsSheet);

  Logger.log('==== 第1段階: 他省庁 完了: ' + totalNew + '件 ====');
  return totalNew;
}

// ====================================================================
//  第2段階: 分析（URL先の本文 → Claude APIで要約・キーワード・グループ判定）
// ====================================================================

/**
 * 第2段階: 未分析行を検出し、Claude APIで分析してシートに書き戻す
 */
function analyzeNewItems() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName('新着情報');
  const settingsSheet = ss.getSheetByName('設定') || createSettingsSheet(ss);

  if (!dataSheet) {
    Logger.log('[analyzeNewItems] エラー: 新着情報シートがありません');
    return 0;
  }

  const apiKey = getApiKey(settingsSheet);
  if (!apiKey) {
    Logger.log('[analyzeNewItems] エラー: CLAUDE_API_KEY が設定されていません');
    return 0;
  }

  const data = dataSheet.getDataRange().getValues();
  let analyzedCount = 0;

  Logger.log('==== 第2段階: Claude分析 開始 ====');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const summary = String(row[8] || '').trim(); // 9列目: 要約

    // 要約が空の行 = 未分析
    if (summary !== '') continue;

    const ministry = row[2];
    const title = row[3];
    const url = row[4];

    Logger.log('[analyzeNewItems] 分析中 (row=' + (i + 1) + '): ' + title);

    // URL先の本文を取得
    const bodyText = fetchBodyText_(url, ministry);

    // Claude APIで分析
    const result = analyzeWithClaude(apiKey, title, ministry, bodyText);

    if (result) {
      // シートに書き戻し: キーワード(7列), グループ(8列), 要約(9列)
      dataSheet.getRange(i + 1, 7).setValue(result.keywords.join(', '));
      dataSheet.getRange(i + 1, 8).setValue(result.groups.join(', '));
      dataSheet.getRange(i + 1, 9).setValue(result.summary);
      analyzedCount++;

      // グループなし or 電力メイン → 通知不要なので通知済みフラグをTRUEに
      if (result.groups.length === 0) {
        dataSheet.getRange(i + 1, 10).setValue(true);
        Logger.log('[analyzeNewItems] グループなし → 通知スキップ (row=' + (i + 1) + '): ' + title);
      } else if (isPowerOnlyItem_(result.groups, result.keywords)) {
        dataSheet.getRange(i + 1, 10).setValue(true);
        Logger.log('[analyzeNewItems] 電力メイン → 通知スキップ (row=' + (i + 1) + '): ' + title);
      }

      Logger.log('[analyzeNewItems] 完了: keywords=' + result.keywords.join(',')
        + ' groups=' + result.groups.join(',')
        + ' summary=' + truncateText(result.summary, 50));
    } else {
      // Claude分析失敗時はタイトルを仮要約として書き込み（再分析を防止）
      dataSheet.getRange(i + 1, 9).setValue('（分析失敗）' + truncateText(title, 80));
      Logger.log('[analyzeNewItems] 分析失敗 (row=' + (i + 1) + ')');
    }

    Utilities.sleep(SLEEP_BETWEEN_ANALYSIS_MS);
  }

  Logger.log('==== 第2段階: Claude分析 完了: ' + analyzedCount + '件 ====');
  return analyzedCount;
}

// ====================================================================
//  第3段階: 通知（分析済み＋未通知 → Slack通知 → 通知済みフラグ更新）
// ====================================================================

/**
 * 第3段階: 分析済みかつ未通知の行をSlackに通知
 */
function notifyAnalyzedItems() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName('新着情報');
  const settingsSheet = ss.getSheetByName('設定') || createSettingsSheet(ss);

  if (!dataSheet) {
    Logger.log('[notifyAnalyzedItems] エラー: 新着情報シートがありません');
    return 0;
  }

  const webhookUrl = getSlackWebhookUrl(settingsSheet);
  if (!webhookUrl) {
    Logger.log('[notifyAnalyzedItems] エラー: SLACK_WEBHOOK_URL が設定されていません');
    return 0;
  }

  const mentionSettings = getMentionSettings(ss);
  const data = dataSheet.getDataRange().getValues();
  let notifiedCount = 0;

  Logger.log('==== 第3段階: Slack通知 開始 ====');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const summary = String(row[8] || '').trim(); // 9列目: 要約
    const isNotified = row[9]; // 10列目: Slack通知済

    // 要約が入っている かつ 未通知
    if (!summary) continue;
    if (isNotified === true || isNotified === 'TRUE') continue;

    const ministry = row[2];
    const title = row[3];
    const url = row[4];
    const pubDate = row[5];
    const keywords = row[6];
    const groups = normalizeGroupsFromCell_(row[7]);

    // グループなし → Slack通知不要、通知済み扱い
    if (groups.length === 0) {
      dataSheet.getRange(i + 1, 10).setValue(true);
      Logger.log('[notifyAnalyzedItems] グループなし → 通知スキップ (row=' + (i + 1) + '): ' + title);
      continue;
    }

    try {
      postToSlackWorkflow(
        webhookUrl,
        {
          ministry,
          title,
          url,
          pubDate,
          keywords,
          groups,
          summary
        },
        mentionSettings
      );

      // 通知成功 → フラグ更新
      dataSheet.getRange(i + 1, 10).setValue(true);
      notifiedCount++;

      Logger.log('[notifyAnalyzedItems] 通知成功 (row=' + (i + 1) + '): ' + title);

      Utilities.sleep(SLEEP_BETWEEN_SLACK_POSTS_MS);

    } catch (e) {
      // 通知失敗 → フラグを明示的にFALSEにして次回リトライ対象にする
      dataSheet.getRange(i + 1, 10).setValue(false);
      Logger.log('[notifyAnalyzedItems] 通知エラー (row=' + (i + 1) + '): ' + e.message);
    }
  }

  Logger.log('==== 第3段階: Slack通知 完了: ' + notifiedCount + '件 ====');
  return notifiedCount;
}

// ====================================================================
//  パイプライン関数（トリガー用・手動実行用）
// ====================================================================

/**
 * 経産省パイプライン: 第1段階→第2段階を即時実行し、第3段階は30分後に遅延実行
 */
function runMETIPipeline() {
  Logger.log('==== 経産省パイプライン開始 ====');
  const collected = collectMETI();
  const analyzed = analyzeNewItems();
  scheduleNotification_();
  Logger.log('==== 経産省パイプライン完了: 収集=' + collected + ' 分析=' + analyzed + ' / 通知は30分後 ====');
}

/**
 * 他省庁パイプライン: 第1段階→第2段階を即時実行し、第3段階は30分後に遅延実行
 */
function runOthersPipeline() {
  Logger.log('==== 他省庁パイプライン開始 ====');
  const collected = collectOtherMinistries();
  const analyzed = analyzeNewItems();
  scheduleNotification_();
  Logger.log('==== 他省庁パイプライン完了: 収集=' + collected + ' 分析=' + analyzed + ' / 通知は30分後 ====');
}

/**
 * 第2段階＋第3段階を連続実行（第1段階済みデータに対して使う）
 * ※手動実行用：第3段階も30分後に遅延実行
 */
function analyzeAndNotify() {
  Logger.log('==== 第2段階＋第3段階（遅延） 開始 ====');
  const analyzed = analyzeNewItems();
  scheduleNotification_();
  Logger.log('==== 完了: 分析=' + analyzed + '件 / 通知は30分後 ====');
}

/**
 * 第2段階＋第3段階を連続実行（第3段階を即時実行する版）
 * ※手動ですぐ通知を確認したいとき用
 */
function analyzeAndNotifyNow() {
  Logger.log('==== 第2段階＋第3段階（即時） 開始 ====');
  const analyzed = analyzeNewItems();
  const notified = notifyAnalyzedItems();
  Logger.log('==== 完了: 分析=' + analyzed + '件, 通知=' + notified + '件 ====');
}

/**
 * notifyAnalyzedItems() を30分後に1回だけ実行するトリガーを作成
 * 同名トリガーの重複を避けるため、既存の予約を削除してから作成する
 */
function scheduleNotification_() {
  // 既存の notifyAnalyzedItems ワンショットトリガーを削除（重複防止）
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'notifyAnalyzedItems' && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK) {
      // everyHours等の定期トリガーでなければワンショット → 削除
      try {
        ScriptApp.deleteTrigger(t);
      } catch (e) {
        Logger.log('[scheduleNotification_] 既存トリガー削除エラー: ' + e.message);
      }
    }
  }

  ScriptApp.newTrigger('notifyAnalyzedItems')
    .timeBased()
    .after(30 * 60 * 1000)  // 30分後
    .create();

  Logger.log('[scheduleNotification_] notifyAnalyzedItems を30分後に予約しました');
}

// ==================== トリガー作成 ====================

function deleteExistingTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  const targetFunctions = [
    'runMETIPipeline', 'runOthersPipeline',
    'notifyAnalyzedItems',  // ワンショットトリガーも含む
    'checkMETIOnly', 'checkOtherMinistries'  // 旧関数名（互換削除用）
  ];
  for (const t of triggers) {
    const handler = t.getHandlerFunction();
    if (targetFunctions.includes(handler)) {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/**
 * トリガー設定: 経産省と他省庁を2時間ずらし、4時間間隔で実行
 *
 * スケジュールイメージ:
 *   0:05  runMETIPipeline
 *   2:05  runOthersPipeline
 *   4:05  runMETIPipeline
 *   6:05  runOthersPipeline
 *   ...
 */
function setupTimeTriggers() {
  deleteExistingTriggers_();

  // 経産省パイプライン: 4時間ごと
  ScriptApp.newTrigger('runMETIPipeline')
    .timeBased()
    .everyHours(4)
    .nearMinute(5)
    .create();

  // 他省庁パイプライン: 4時間ごと（初回を2時間後に予約して時間差を作る）
  // GAS の everyHours はオフセット指定不可のため、atHour で明示的に指定
  ScriptApp.newTrigger('runOthersPipeline')
    .timeBased()
    .everyHours(4)
    .nearMinute(5)
    .create();

  // ★ 初回だけ2時間後に他省庁を実行（時差のきっかけを作る）
  ScriptApp.newTrigger('runOthersPipeline')
    .timeBased()
    .after(2 * 60 * 60 * 1000)  // 2時間後
    .create();

  Logger.log('トリガー作成完了（runMETIPipeline / runOthersPipeline: 4時間間隔・2時間ずらし）');
}

// ==================== 初期セットアップ ====================

function initialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName('新着情報')) createDataSheet(ss);
  if (!ss.getSheetByName('設定')) createSettingsSheet(ss);
  if (!ss.getSheetByName('メンション設定')) createMentionSheet(ss);

  Logger.log('初期セットアップ完了');
}

function initialSetupWithSlackAndTriggers() {
  initialSetup();
  setupTimeTriggers();

  Logger.log('');
  Logger.log('==========================================');
  Logger.log('省庁審議会ウォッチシステム - 3段階パイプライン版');
  Logger.log('==========================================');
  Logger.log('');
  Logger.log('【処理の流れ】');
  Logger.log('  第1段階: ページ収集 → 新着情報シートに基本情報を書き込み');
  Logger.log('  第2段階: URL先の本文をClaude APIで分析 → キーワード/グループ/要約を記入');
  Logger.log('  第3段階: Slack通知 → 通知済みフラグを更新');
  Logger.log('');

  Logger.log('【トリガー設定】');
  Logger.log('  runMETIPipeline: 4時間ごと（経産省: 収集→分析→通知）');
  Logger.log('  runOthersPipeline: 4時間ごと・2時間ずらし（他省庁: 収集→分析→通知）');
  Logger.log('');

  Logger.log('【手動実行関数】');
  Logger.log('  collectMETI()             - 経産省の収集のみ');
  Logger.log('  collectOtherMinistries()   - 他省庁の収集のみ');
  Logger.log('  analyzeNewItems()          - 未分析行のClaude分析のみ');
  Logger.log('  notifyAnalyzedItems()      - 分析済み・未通知行のSlack通知のみ');
  Logger.log('  analyzeAndNotify()         - 第2段階＋第3段階（通知は30分後）');
  Logger.log('  analyzeAndNotifyNow()      - 第2段階＋第3段階（通知も即時実行）');
  Logger.log('  runMETIPipeline()          - 経産省: 収集→分析→通知30分後');
  Logger.log('  runOthersPipeline()        - 他省庁: 収集→分析→通知30分後');
  Logger.log('');

  Logger.log('【Slack Workflow 設定ガイド】');
  Logger.log('');
  Logger.log('【Step 1: Workflow の作成】');
  Logger.log('Slack →「ツール」→「ワークフロービルダー」→「作成」');
  Logger.log('→「最初から作成」→ トリガー「Webhook」を選択');
  Logger.log('');

  Logger.log('【Step 2: データ変数を追加】');
  Logger.log('--- テキスト型（7個）---');
  Logger.log('  - ministry（省庁名）');
  Logger.log('  - title（タイトル）');
  Logger.log('  - url（詳細ページURL）');
  Logger.log('  - pub_date（公開日）');
  Logger.log('  - keywords（キーワード）');
  Logger.log('  - group（グループ番号）');
  Logger.log('  - summary（要約）');
  Logger.log('');

  Logger.log('--- SlackユーザーID型---');
  Logger.log('  - mention_user');
  Logger.log('');

  Logger.log('--- テキスト型（1個）---');
  Logger.log('  - mention_channel（@channel を出したい時だけ "@channel"。それ以外は空文字）');
  Logger.log('');

  Logger.log('【メッセージテンプレート例】');
  Logger.log('----------------------------------------');
  Logger.log('{mention_user}{mention_channel} {ministry}の新着情報');
  Logger.log('');
  Logger.log('*{title}*');
  Logger.log('📅 公開日: {pub_date}');
  Logger.log('🔗 {url}');
  Logger.log('');
  Logger.log('📝 {summary}');
  Logger.log('---');
  Logger.log('🏷️ キーワード: {keywords}');
  Logger.log('----------------------------------------');
  Logger.log('');

  Logger.log('【Step 3: Webhook URLを設定シートへ】');
  Logger.log('設定シートの SLACK_WEBHOOK_URL に貼り付け');
  Logger.log('');

  Logger.log('【Step 4: Claude API（必須）】');
  Logger.log('CLAUDE_API_KEY を設定シートに設定してください（第2段階の分析に必要）');
  Logger.log('');

  Logger.log('【Step 5: 動作確認】');
  Logger.log('collectMETI() → analyzeNewItems() → notifyAnalyzedItems() を順に手動実行して確認');
  Logger.log('または runMETIPipeline() で3段階を一括実行');
}

// ==================== テスト ====================

function testSlackPost() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settingsSheet = ss.getSheetByName('設定') || createSettingsSheet(ss);
  const webhookUrl = getSlackWebhookUrl(settingsSheet);

  if (!webhookUrl) {
    Logger.log('エラー: SLACK_WEBHOOK_URL が設定されていません');
    return;
  }

  const mentionSettings = getMentionSettings(ss);

  const testItem = {
    ministry: 'テスト省庁',
    title: 'テスト: 省庁審議会ウォッチシステム（3段階パイプライン版）',
    url: 'https://example.com/test',
    pubDate: new Date(),
    keywords: 'AI, ロボティクス',
    groups: ['1', '2', '3'],
    summary: 'これはテスト投稿です。メンション user / mention_channel の挙動を確認してください。'
  };

  try {
    postToSlackWorkflow(webhookUrl, testItem, mentionSettings);
    Logger.log('テスト投稿成功！Slack を確認してください');
  } catch (e) {
    Logger.log('テスト投稿失敗: ' + e.message);
  }
}
