// ▼▼▼ ここだけ龍之介さんが設定 ▼▼▼
const NOTION_TOKEN = PropertiesService.getScriptProperties().getProperty("NOTION_TOKEN");
// ▲▲▲ 設定はここまで ▲▲▲

// 見積もり履歴データベースのID
const MITSUMORI_DB_ID = "3490d14e49c445bc963d1378f4a96e12";

const NOTION_VERSION = "2022-06-28";

// 運営者キー（スクリプトプロパティ OWNER_KEY）。未設定なら全リクエスト拒否（fail-safe）
const OWNER_KEY = PropertiesService.getScriptProperties().getProperty("OWNER_KEY");

/**
 * 運営者キー検証。OWNER_KEY 未設定 / 不一致は false。
 */
function checkOwnerKey_(key) {
  if (!OWNER_KEY) { console.warn("OWNER_KEY 未設定のため拒否"); return false; }
  return String(key || "") === String(OWNER_KEY);
}

/**
 * mitsumori.html からの POST を受ける入口（見積もりを保存）
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (!checkOwnerKey_(data.ownerKey)) {
      console.warn("doPost: 認証失敗");
      return json_({ ok: false, message: "Unauthorized" });
    }
    delete data.ownerKey;   // 明細JSON（safeJson_(data)）に鍵が書き込まれないよう検証後に除去

    const atena = (data.atena || "").trim();
    const ninzu = (data.family && data.family.length) ? data.family.length : 0;
    const dateStr = data.date || todayStr_();
    const titleText =
      (atena ? atena + "様" : "お名前未記入") +
      "ご家族（" + ninzu + "名）" + dateStr;

    const properties = {
      "タイトル": { title: [ { text: { content: titleText } } ] },
      "あて名":   { rich_text: [ { text: { content: atena } } ] },
      "作成日":   { date: { start: dateStr } },
      "人数":     { number: ninzu },
      "家族合計月々": { number: toNum_(data.familyMonthly) },
      "初回費用合計": { number: toNum_(data.jimuTotal) },
      "明細JSON": { rich_text: jsonRichText_(data) },
    };

    if (data.source) {
      properties["作成元"] = { select: { name: data.source } };
    }

    // 顧客マスターへの紐付け（customerPageId が来ていれば relation で接続）
    if (data.customerPageId) {
      properties["顧客マスター"] = { relation: [ { id: data.customerPageId } ] };
    }

    const res = UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
      method: "post",
      contentType: "application/json",
      headers: {
        "Authorization": "Bearer " + NOTION_TOKEN,
        "Notion-Version": NOTION_VERSION,
      },
      payload: JSON.stringify({
        parent: { database_id: MITSUMORI_DB_ID },
        properties: properties,
      }),
      muteHttpExceptions: true,
    });

    const code = res.getResponseCode();
    if (code === 200 || code === 201) {
      return json_({ ok: true, message: "保存しました" });
    } else {
      return json_({ ok: false, message: "Notion保存に失敗", detail: res.getContentText() });
    }
  } catch (err) {
    return json_({ ok: false, message: "エラー: " + err });
  }
}

/**
 * mitsumori.html からの GET を受ける入口
 * 直近の見積もり履歴を新しい順に最大10件返す
 */
function doGet(e) {
  try {
    const key = (e && e.parameter) ? e.parameter.key : "";
    if (!checkOwnerKey_(key)) {
      console.warn("doGet: 認証失敗");
      return json_({ ok: false, message: "Unauthorized" });
    }

    const res = UrlFetchApp.fetch(
      "https://api.notion.com/v1/databases/" + MITSUMORI_DB_ID + "/query",
      {
        method: "post",
        contentType: "application/json",
        headers: {
          "Authorization": "Bearer " + NOTION_TOKEN,
          "Notion-Version": NOTION_VERSION,
        },
        payload: JSON.stringify({
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: 10,
        }),
        muteHttpExceptions: true,
      }
    );

    const code = res.getResponseCode();
    if (code !== 200) {
      return json_({ ok: false, message: "Notion取得に失敗", detail: res.getContentText() });
    }

    const body = JSON.parse(res.getContentText());
    const items = (body.results || []).map(function (page) {
      const p = page.properties || {};
      return {
        id: page.id,
        label: readTitle_(p["タイトル"]),
        savedAt: readDate_(p["作成日"]) || (page.created_time || ""),
        ninzu: readNumber_(p["人数"]),
        payload: readRichText_(p["明細JSON"]),
      };
    });

    return json_({ ok: true, items: items });
  } catch (err) {
    return json_({ ok: false, message: "エラー: " + err });
  }
}

/* ---------- 補助関数 ---------- */
function todayStr_() {
  const d = new Date();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  return d.getFullYear() + "-" + m + "-" + day;
}
function toNum_(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}
function safeJson_(obj) {
  return JSON.stringify(obj);
}
function jsonRichText_(obj) {
  const json = safeJson_(obj);
  const chunks = [];
  // UTF-16のサロゲートペアを分断せず、Notionの各textを2000文字以内にする。
  let chunk = '';
  for (const char of json) {
    if (chunk.length + char.length > 1900) {
      chunks.push({ text: { content: chunk } });
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push({ text: { content: chunk } });
  if (chunks.length > 100) throw new Error('見積もりが大きすぎます。人数や明細を分けて保存してください。');
  return chunks;
}
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---- doGet 用の読み取りヘルパー ---- */
function readTitle_(prop) {
  if (!prop || !prop.title || !prop.title.length) return "(無題)";
  return prop.title.map(function (t) { return t.plain_text; }).join("");
}
function readRichText_(prop) {
  if (!prop || !prop.rich_text || !prop.rich_text.length) return "";
  return prop.rich_text.map(function (t) { return t.plain_text; }).join("");
}
function readDate_(prop) {
  if (!prop || !prop.date || !prop.date.start) return "";
  return prop.date.start;
}
function readNumber_(prop) {
  if (!prop || prop.number == null) return 0;
  return prop.number;
}
