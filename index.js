// index.js

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// ----- Environment variables -----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PPLX_API_KEY = process.env.PPLX_API_KEY;

// Public URL for your Railway app (no trailing slash)
const PUBLIC_URL = "https://perplexity-tele-bot-production.up.railway.app";

// Directory for persistent files (Railway Volume mounted at /data)
const DATA_DIR = process.env.DATA_DIR || "/data";

// OneDrive config (app-only auth, uploading into a specific user's drive)
const ONEDRIVE_CLIENT_ID = process.env.ONEDRIVE_CLIENT_ID;
const ONEDRIVE_TENANT_ID = process.env.ONEDRIVE_TENANT_ID;
const ONEDRIVE_CLIENT_SECRET = process.env.ONEDRIVE_CLIENT_SECRET;
const ONEDRIVE_USER = process.env.ONEDRIVE_USER; // UPN in your tenant
const ONEDRIVE_FOLDER_PATH = process.env.ONEDRIVE_FOLDER_PATH || "/TelegramBot";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}
if (!PPLX_API_KEY) {
  console.error("Missing PPLX_API_KEY env var");
  process.exit(1);
}

// In‑memory per‑chat upload preference ("onedrive" or "gdrive")
const uploadTargetByChat = new Map();

// Ensure data directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  console.log("DATA_DIR ready at:", DATA_DIR);
} catch (err) {
  console.error("Failed to prepare DATA_DIR:", err);
}

console.log("TELEGRAM_BOT_TOKEN present?", !!TELEGRAM_BOT_TOKEN);
console.log("PPLX_API_KEY present?", !!PPLX_API_KEY);
console.log("PUBLIC_URL:", PUBLIC_URL);

// ----- Express app -----
const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Simple save route to test file writes:
// POST /save { "filename": "test.json", "data": { "foo": "bar" } }
app.post("/save", async (req, res) => {
  const { filename, data } = req.body || {};
  if (!filename || !data) {
    return res.status(400).json({ error: "filename and data are required" });
  }

  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    console.log("Saved file:", filePath);

    if (
      ONEDRIVE_CLIENT_ID &&
      ONEDRIVE_TENANT_ID &&
      ONEDRIVE_CLIENT_SECRET &&
      ONEDRIVE_USER
    ) {
      // Treat global scripts as common files
      await uploadFileToOneDrive(filePath, filename, "global", "Common Files/Misc");
    }

    return res.status(200).json({ ok: true, path: filePath });
  } catch (err) {
    console.error("Error writing file:", err);
    return res.status(500).json({ error: "failed to write file" });
  }
});

// Webhook config
const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

console.log("Webhook will be set to:", WEBHOOK_URL);

// Root check
app.get("/", (req, res) => {
  res.send("Telegram + Perplexity bot is running");
});

// Telegram sends updates here
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const update = req.body;

    console.log("Incoming Telegram update:", JSON.stringify(update));

    const message = update.message;
    if (!message) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    // ---- /mkdir command: create a folder in OneDrive under this chat ----
    if (text.toLowerCase().startsWith("/mkdir")) {
      const parts = text.split(" ").filter(Boolean);
      if (parts.length < 2) {
        await sendTelegramMessage(
          chatId,
          "Usage: /mkdir <folder-name>"
        );
        return res.sendStatus(200);
      }

      const folderName = parts
        .slice(1)
        .join("_")
        .replace(/[^\w.\-]/g, "_");

      try {
        await createOneDriveFolder(folderName, chatId);
        await sendTelegramMessage(
          chatId,
          `Created folder \`${folderName}\` in OneDrive under \`${ONEDRIVE_FOLDER_PATH}/chat_${chatId}\`.`
        );
      } catch (err) {
        await sendTelegramMessage(
          chatId,
          "I failed to create that folder. Check the logs for details."
        );
      }

      return res.sendStatus(200);
    }

    // ---- /upload_onedrive: next file -> OneDrive ----
    if (text.toLowerCase().startsWith("/upload_onedrive")) {
      uploadTargetByChat.set(chatId, "onedrive");
      await sendTelegramMessage(
        chatId,
        "Okay, your *next* file or photo will be uploaded to OneDrive (as well as saved locally)."
      );
      return res.sendStatus(200);
    }

    // ---- /upload_gdrive: next file -> Google Drive ----
    if (text.toLowerCase().startsWith("/upload_gdrive")) {
      uploadTargetByChat.set(chatId, "gdrive");
      await sendTelegramMessage(
        chatId,
        "Okay, your *next* file or photo will be uploaded to Google Drive (as well as saved locally)."
      );
      return res.sendStatus(200);
    }

    // ---- /remember command: recall last memory matching a keyword ----
    if (text.toLowerCase().startsWith("/remember")) {
      const parts = text.split(" ").filter(Boolean);
      if (parts.length < 2) {
        await sendTelegramMessage(
          chatId,
          "Usage: /remember <keyword> (e.g. /remember teacher)"
        );
        return res.sendStatus(200);
      }

      const keyword = parts.slice(1).join(" ");
      const recalled = recallFromLog(keyword, null);

      if (recalled) {
        await sendTelegramMessage(
          chatId,
          `Last thing I noted about "${keyword}" was: ${recalled}`
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `I don't have anything about "${keyword}" saved yet.`
        );
      }

      return res.sendStatus(200);
    }

    // Simple recall example for teacher's name (shortcut)
    if (
      text.toLowerCase() === "what's my teacher's name?" ||
      text.toLowerCase() === "whats my teacher's name?" ||
      text.toLowerCase() === "whats my teachers name?" ||
      text.toLowerCase() === "what's my teachers name?"
    ) {
      const recalled = recallFromLog("teacher", "common");

      if (recalled) {
        await sendTelegramMessage(
          chatId,
          `You told me your teacher is ${recalled}.`
        );
      } else {
        await sendTelegramMessage(
          chatId,
          "I don't see that in my notes yet."
        );
      }
      return res.sendStatus(200);
    }

    // 1) Handle documents (files)
    if (message.document) {
      const doc = message.document;
      const fileId = doc.file_id;
      const originalName = doc.file_name || `${fileId}.bin`;

      try {
        const localPath = await downloadTelegramFile(fileId, originalName, chatId);

        // Decide folder based on last command and (optionally) caption
        const target = uploadTargetByChat.get(chatId);
        let onedriveKind = "Common Files/Misc";

        if (message.caption) {
          const cat = categorizeMemory(message.caption);
          if (cat === "poems") onedriveKind = "Poems";
          else if (cat === "theatre") onedriveKind = "Theatre";
          else onedriveKind = "Common Files/Notes";
        }

        if (target === "onedrive") {
          await uploadFileToOneDrive(localPath, path.basename(localPath), chatId, onedriveKind);
          uploadTargetByChat.delete(chatId);
        } else if (target === "gdrive") {
          await uploadFileToGoogleDrive(localPath, path.basename(localPath), chatId);
          uploadTargetByChat.delete(chatId);
        }

        await sendTelegramMessage(
          chatId,
          `I saved your file as \`${path.basename(localPath)}\` on the server.`
        );
      } catch (err) {
        console.error("Failed to download/save document:", err);
        await sendTelegramMessage(
          chatId,
          "I got your file but failed to save it. Please try again later."
        );
      }

      return res.sendStatus(200);
    }

    // 2) Handle photos (save highest-resolution variant)
    if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
      const bestPhoto = message.photo[message.photo.length - 1];
      const fileId = bestPhoto.file_id;
      const originalName = `photo_${fileId}.jpg`;

      try {
        const localPath = await downloadTelegramFile(fileId, originalName, chatId);

        const target = uploadTargetByChat.get(chatId);
        let onedriveKind = "Common Files/Misc";

        if (message.caption) {
          const cat = categorizeMemory(message.caption);
          if (cat === "poems") onedriveKind = "Poems";
          else if (cat === "theatre") onedriveKind = "Theatre";
          else onedriveKind = "Common Files/Ideas";
        }

        if (target === "onedrive") {
          await uploadFileToOneDrive(localPath, path.basename(localPath), chatId, onedriveKind);
          uploadTargetByChat.delete(chatId);
        } else if (target === "gdrive") {
          await uploadFileToGoogleDrive(localPath, path.basename(localPath), chatId);
          uploadTargetByChat.delete(chatId);
        }

        await sendTelegramMessage(
          chatId,
          `I saved your photo as \`${path.basename(localPath)}\` on the server.`
        );
      } catch (err) {
        console.error("Failed to download/save photo:", err);
        await sendTelegramMessage(
          chatId,
          "I got your photo but failed to save it. Please try again later."
        );
      }

      return res.sendStatus(200);
    }

    // 3) If no text and no file-like content
    if (!text) {
      await sendTelegramMessage(
        chatId,
        "I can respond to text, documents, and photos. Try sending a message or a file."
      );
      return res.sendStatus(200);
    }

    // 4) Normal text flow with Perplexity
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Hi! Send me a question and I'll ask Perplexity for you."
      );
      return res.sendStatus(200);
    }

    await sendChatAction(chatId, "typing");

    const answer = await askPerplexity(text);
    await sendTelegramMessage(chatId, answer);

    // Log each text question to a file in /data, with category
    try {
      const logFile = path.join(DATA_DIR, "messages.log");
      const category = categorizeMemory(text); // poems / theatre / common
      const line = `[${new Date().toISOString()}] chat:${chatId} category:${category} text:${JSON.stringify(
        text
      )}\n`;
      fs.appendFileSync(logFile, line, "utf8");

      if (
        ONEDRIVE_CLIENT_ID &&
        ONEDRIVE_TENANT_ID &&
        ONEDRIVE_CLIENT_SECRET &&
        ONEDRIVE_USER
      ) {
        // Store logs under Common Files
        await uploadFileToOneDrive(logFile, "messages.log", chatId, "Common Files/References");
      }
    } catch (err) {
      console.error("Failed to append to log file:", err);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error in webhook handler:", err);
    res.sendStatus(500);
  }
});

// ----- Memory categorisation: poems / theatre / common -----

function categorizeMemory(text) {
  const t = text.toLowerCase();

  // poems
  if (
    t.includes("poem") ||
    t.includes("poetry") ||
    t.includes("haiku") ||
    t.includes("stanza") ||
    t.includes("verse") ||
    t.includes("sonnet") ||
    t.startsWith("roses are") ||
    t.includes("write a poem")
  ) {
    return "poems";
  }

  // theatre
  if (
    t.includes("theatre") || t.includes("theater") ||
    t.includes("script") || t.includes("scene") ||
    t.includes("monologue") || t.includes("dialogue") ||
    t.includes("character") || t.includes("role") ||
    t.includes("blocking") || t.includes("rehearsal") ||
    t.includes("audition") || t.includes("stage")
  ) {
    return "theatre";
  }

  // common (fallback)
  return "common";
}

// ----- Very simple memory recall from messages.log -----

function recallFromLog(keyword, preferredCategory = null) {
  try {
    const logFile = path.join(DATA_DIR, "messages.log");
    if (!fs.existsSync(logFile)) return null;

    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.trim().split("\n").reverse(); // search from latest

    for (const line of lines) {
      if (preferredCategory && !line.includes(`category:${preferredCategory}`)) {
        continue;
      }

      const match = line.match(/text:"(.+?)"/);
      if (!match) continue;
      const msg = match[1];

      if (msg.toLowerCase().includes(keyword.toLowerCase())) {
        return msg;
      }
    }
    return null;
  } catch (err) {
    console.error("Failed to recall from log:", err);
    return null;
  }
}

// ----- Telegram helper functions -----

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("sendMessage error:", data);
  }
}

async function sendChatAction(chatId, action) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;
  const body = {
    chat_id: chatId,
    action,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("sendChatAction error:", data);
  }
}

// ----- Perplexity helper -----

async function askPerplexity(prompt) {
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PPLX_API_KEY}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "You are a helpful Telegram assistant." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Perplexity API error:", res.status, text);
      return "Sorry, I had an issue talking to the AI. Try again later.";
    }

    const data = await res.json();
    const answer =
      data.choices?.[0]?.message?.content?.trim() ||
      "I couldn't generate a response.";
    return answer;
  } catch (err) {
    console.error("Error calling Perplexity:", err);
    return "Sorry, something went wrong while contacting the AI.";
  }
}

// ----- Telegram file download helper -----

async function downloadTelegramFile(fileId, suggestedName, chatId) {
  const getFileUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;

  const metaRes = await fetch(getFileUrl);
  const meta = await metaRes.json();

  if (!meta.ok || !meta.result || !meta.result.file_path) {
    console.error("getFile failed:", meta);
    throw new Error("Failed to get file_path from Telegram");
  }

  const filePathTelegram = meta.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePathTelegram}`;

  console.log("Downloading Telegram file from:", downloadUrl);

  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(
      `Failed to download file: ${fileRes.status} ${fileRes.statusText}`
    );
  }

  const buffer = await fileRes.buffer();

  const safeName = suggestedName.replace(/[^\w.\-]/g, "_");
  const localPath = path.join(DATA_DIR, safeName);

  fs.writeFileSync(localPath, buffer);
  console.log("Saved Telegram file to:", localPath);

  // Upload is now controlled by slash commands in the message handlers
  return localPath;
}

// ----- OneDrive helpers -----

async function getOneDriveAccessToken() {
  if (
    !ONEDRIVE_CLIENT_ID ||
    !ONEDRIVE_TENANT_ID ||
    !ONEDRIVE_CLIENT_SECRET
  ) {
    throw new Error("OneDrive env vars not set");
  }

  const tokenUrl = `https://login.microsoftonline.com/${ONEDRIVE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams();
  params.append("client_id", ONEDRIVE_CLIENT_ID);
  params.append("client_secret", ONEDRIVE_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");
  params.append("scope", "https://graph.microsoft.com/.default");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(
      "OneDrive token error:",
      JSON.stringify(data, null, 2),
      "status:",
      res.status,
      res.statusText
    );
    throw new Error("Failed to get OneDrive token");
  }
  return data.access_token;
}

// Upload into /TelegramBot/chat_<chatId>/<kind>/
async function uploadFileToOneDrive(localPath, remoteFileName, chatId, kind = "Common Files/Misc") {
  try {
    if (!ONEDRIVE_USER) {
      throw new Error("ONEDRIVE_USER not set");
    }
    if (!chatId) {
      throw new Error("chatId is required for uploadFileToOneDrive");
    }

    const token = await getOneDriveAccessToken();
    const fileBuffer = fs.readFileSync(localPath);

    const baseFolder = ONEDRIVE_FOLDER_PATH; // e.g. "/TelegramBot"
    // kind may be "Poems", "Theatre", or "Common Files/SubFolder"
    const folderPath = `${baseFolder}/chat_${chatId}/${kind}`;

    const uploadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      ONEDRIVE_USER
    )}/drive/root:${folderPath}/${remoteFileName}:/content`;

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(
        "OneDrive upload error:",
        JSON.stringify(data, null, 2),
        "status:",
        res.status,
        res.statusText
      );
    } else {
      console.log("Uploaded to OneDrive:", data.name);
    }
  } catch (err) {
    console.error("Failed to upload to OneDrive:", err);
  }
}

// Create a OneDrive folder via .keep file under /TelegramBot/chat_<chatId>/<folderName>/
async function createOneDriveFolder(folderName, chatId) {
  try {
    if (!ONEDRIVE_USER) throw new Error("ONEDRIVE_USER not set");
    if (!chatId) throw new Error("chatId is required for createOneDriveFolder");

    const token = await getOneDriveAccessToken();
    const buffer = Buffer.from("folder placeholder");

    const baseFolder = ONEDRIVE_FOLDER_PATH; // e.g. "/TelegramBot"
    const folderPath = `${baseFolder}/chat_${chatId}/${folderName}`;
    const fileName = ".keep";

    const uploadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      ONEDRIVE_USER
    )}/drive/root:${folderPath}/${fileName}:/content`;

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: buffer,
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(
        "OneDrive mkdir error:",
        JSON.stringify(data, null, 2),
        "status:",
        res.status,
        res.statusText
      );
      throw new Error("Failed to create folder");
    } else {
      console.log("Created OneDrive folder via .keep:", folderPath);
    }
  } catch (err) {
    console.error("Failed to create OneDrive folder:", err);
    throw err;
  }
}

// ----- Google Drive helper (stub) -----
// Implement this with googleapis when you're ready
async function uploadFileToGoogleDrive(localPath, remoteFileName, chatId) {
  try {
    console.log(
      `Stub: would upload ${localPath} as ${remoteFileName} to Google Drive for chat ${chatId}`
    );
  } catch (err) {
    console.error("Failed to upload to Google Drive:", err);
  }
}

// ----- Webhook setup (non-blocking) -----

async function ensureWebhook() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: WEBHOOK_URL }),
    });
    const data = await res.json();
    console.log("setWebhook response:", data);
  } catch (err) {
    console.error("Failed to set Telegram webhook:", err);
  }
}

// ----- Start server -----

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Webhook URL:", WEBHOOK_URL);
  console.log("Data directory:", DATA_DIR);
  ensureWebhook();
});
