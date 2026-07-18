/**
 * kakeibox Cloud Functions
 *
 * クレジットカード/決済の利用明細CSV（カード会社・フォーマットは不定）を
 * Gemini 2.5 Flash Lite で解析・分類して取引配列を返す HTTPS Callable 関数。
 *
 * APIキーは functions/.env の GEMINI_API_KEY から読み込む（リポジトリには含めない）。
 *   functions/.env:
 *     GEMINI_API_KEY=＜あなたのキー＞
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

// PromptPad と同じく東京リージョン想定。同時実行は抑制してコスト暴走を防ぐ。
setGlobalOptions({ region: "asia-northeast1", maxInstances: 10 });

const MAX_CSV_CHARS = 300000; // 約300KB
const MAX_TX = 3000;

exports.classifyCreditCsv = onCall(
  { timeoutSeconds: 120, memory: "256MiB" },
  async (request) => {
    // ログインユーザーのみ（不正利用・コスト保護）
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です");
    }

    const csv = String(request.data && request.data.csv ? request.data.csv : "");
    const categories = Array.isArray(request.data && request.data.categories)
      ? request.data.categories.filter((c) => typeof c === "string").slice(0, 40)
      : [];

    if (!csv.trim()) {
      throw new HttpsError("invalid-argument", "CSVが空です");
    }
    if (csv.length > MAX_CSV_CHARS) {
      throw new HttpsError("invalid-argument", "CSVが大きすぎます（300KB以下にしてください）");
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "GEMINI_API_KEY が未設定です");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              date: { type: SchemaType.STRING, description: "取引日 YYYY-MM-DD" },
              name: { type: SchemaType.STRING, description: "利用先・店名" },
              amount: { type: SchemaType.NUMBER, description: "金額（円・支払額、返金は負数）" },
              category: { type: SchemaType.STRING, description: "分類カテゴリ名" },
            },
            required: ["date", "name", "amount", "category"],
          },
        },
      },
    });

    const catLine = categories.length
      ? `category は次のいずれかから内容に最も近いものを選ぶ: ${categories.join("、")}`
      : "category は内容から適切な日本語カテゴリ名を付ける";

    const thisYear = new Date().getFullYear();
    const prompt = `あなたはクレジットカード・QR決済などの利用明細パーサーです。
以下のCSV（カード会社やフォーマットは不定。区切り・列順・ヘッダーの有無も様々）を解析し、
各「利用明細1行」を取引として抽出し、指定スキーマのJSON配列で返してください。

ルール:
- date: 取引日/利用日を YYYY-MM-DD 形式。年が無ければ ${thisYear} 年と推定。
- name: 利用先・店名・摘要。
- amount: 金額（数値・円）。支払金額を採用。返金・キャンセル等のマイナスはそのまま負数。
- ${catLine}
- ヘッダー行・合計行・残高行・繰越行・注記・空行は取引に含めない。実際の利用明細行のみ。
- 通貨記号・カンマは除去して数値化する。

CSV:
"""
${csv}
"""`;

    let txs;
    try {
      const result = await model.generateContent(prompt);
      txs = JSON.parse(result.response.text());
    } catch (err) {
      console.error("[classifyCreditCsv] failed", err);
      throw new HttpsError("internal", "明細の解析に失敗しました。CSVを確認してください。");
    }

    if (!Array.isArray(txs)) txs = [];
    // 軽い正規化
    const clean = txs
      .filter((t) => t && typeof t === "object")
      .slice(0, MAX_TX)
      .map((t) => ({
        date: String(t.date || "").slice(0, 10),
        name: String(t.name || "").slice(0, 120),
        amount: Number(t.amount) || 0,
        category: String(t.category || "その他").slice(0, 40),
      }));

    return { transactions: clean, count: clean.length };
  }
);
