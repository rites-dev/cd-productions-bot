// index.js

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ----- Environment variables -----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PPLX_API_KEY = process.env.PPLX_API_KEY;

// Public URL for your Railway app (no trailing slash)
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "https://perplexity-tele-bot-production.up.railway.app";

// Directory for persistent files (Railway Volume mounted at /data)
const DATA_DIR = process.env.DATA_DIR || "/data";

// OneDrive config (app-only auth, uploading into a specific user's drive)
const ONEDRIVE_CLIENT_ID = process.env.ONEDRIVE_CLIENT_ID;
const ONEDRIVE_TENANT_ID = process.env.ONEDRIVE_TENANT_ID;
const ONEDRIVE_CLIENT_SECRET = process.env.ONEDRIVE_CLIENT_SECRET;
const ONEDRIVE_USER = process.env.ONEDRIVE_USER; // UPN in your tenant
const ONEDRIVE_FOLDER_PATH =
  process.env.ONEDRIVE_FOLDER_PATH || "/TelegramBot";

// Google OAuth / Drive config
const GDRIVE_OAUTH_CLIENT_ID = process.env.GDRIVE_OAUTH_CLIENT_ID;
const GDRIVE_OAUTH_CLIENT_SECRET = process.env.GDRIVE_OAUTH_CLIENT_SECRET;
const GDRIVE_REDIRECT_URI = process.env.GDRIVE_REDIRECT_URI;
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID; // Root Shared Drive

// Google Drive subfolder IDs (routing)
const GDRIVE_FOLDER_POEMS = process.env.GDRIVE_FOLDER_POEMS;
const GDRIVE_FOLDER_THEATRE = process.env.GDRIVE_FOLDER_THEATRE;

// New: granular common folders
const GDRIVE_FOLDER_COMMON_NOTES =
  process.env.GDRIVE_FOLDER_COMMON_NOTES || GDRIVE_FOLDER_ID;
const GDRIVE_FOLDER_COMMON_IDEAS =
  process.env.GDRIVE_FOLDER_COMMON_IDEAS || GDRIVE_FOLDER_ID;
const GDRIVE_FOLDER_COMMON_MISC =
  process.env.GDRIVE_FOLDER_COMMON_MISC || GDRIVE_FOLDER_ID;

// Service account for Admin SDK (domain-wide delegation)
const SA_CLIENT_EMAIL = process.env.SA_CLIENT_EMAIL;
const SA_PRIVATE_KEY = process.env.SA_PRIVATE_KEY;
const SA_TOKEN_URI =
  process.env.SA_TOKEN_URI || "https://oauth2.googleapis.com/token";
const ADMIN_IMPERSONATE = process.env.ADMIN_IMPERSONATE; // e.g. admin@carpediemprods.com

// Domain for new Google Workspace users
const ORG_DOMAIN = "carpediemprods.com";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}
if (!PPLX_API_KEY) {
  console.error("Missing PPLX_API_KEY env var");
  process.exit(1);
}
if (!SA_CLIENT_EMAIL || !SA_PRIVATE_KEY || !ADMIN_IMPERSONATE) {
  console.warn(
    "WARNING: SA_CLIENT_EMAIL / SA_PRIVATE_KEY / ADMIN_IMPERSONATE not fully set. Google user creation will fail."
  );
}

// In‑memory per‑chat upload preference ("onedrive" or "gdrive")
const uploadTargetByChat = new Map();
const pendingUploadByChat = new Map();

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

// Start Google OAuth flow (Drive)
app.get("/auth/google", (req, res) => {
  try {
    const oAuth2Client = getGoogleOAuthClient();

    const scopes = ["https://www.googleapis.com/auth/drive.file"];

    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
    });

    res.redirect(url);
  } catch (err) {
    console.error("Error starting Google OAuth:", err);
    res.status(500).send("Failed to start Google OAuth");
  }
});

// OAuth2 callback URL configured in Google Cloud (Drive)
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("Missing code");
    }

    const oAuth2Client = getGoogleOAuthClient();
    const { tokens } = await oAuth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error("No refresh_token received:", tokens);
      return res
        .status(500)
        .send(
          "No refresh token received. Try removing the app from your Google account and re-authenticating."
        );
    }

    saveGoogleToken(tokens);
    res.send("Google Drive connected! You can close this window.");
  } catch (err) {
    console.error("Error in OAuth callback:", err);
    res.status(500).send("OAuth callback failed.");
  }
});

// Simple save route
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
      await uploadFileToOneDrive(filePath, filename, "global", "Common Files");
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

// Telegram webhook
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

    // /mkdir
    if (text.toLowerCase().startsWith("/mkdir")) {
      const parts = text.split(" ").filter(Boolean);
      if (parts.length < 2) {
        await sendTelegramMessage(chatId, "Usage: /mkdir <folder-name>");
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

    // /uploadonedrive
    if (text.toLowerCase().startsWith("/uploadonedrive")) {
      uploadTargetByChat.set(chatId, "onedrive");
      await sendTelegramMessage(
        chatId,
        "Okay, send me a file or photo, then I'll ask if it's poems, theatre, or common."
      );
      return res.sendStatus(200);
    }

    // /uploadgdrive
    if (text.toLowerCase().startsWith("/uploadgdrive")) {
      uploadTargetByChat.set(chatId, "gdrive");
      await sendTelegramMessage(
        chatId,
        "Okay, send me a file or photo, then I'll ask if it's poems, theatre, or common."
      );
      return res.sendStatus(200);
    }

    // waiting for type answer
    if (pendingUploadByChat.has(chatId)) {
      const pending = pendingUploadByChat.get(chatId);
      const lower = text.toLowerCase();

      if (["poems", "poem"].includes(lower)) {
        await handlePendingUploadWithType(chatId, pending, "poems");
        return res.sendStatus(200);
      }
      if (["theatre", "theater"].includes(lower)) {
        await handlePendingUploadWithType(chatId, pending, "theatre");
        return res.sendStatus(200);
      }
      if (["common", "others", "other"].includes(lower)) {
        await handlePendingUploadWithType(chatId, pending, "common");
        return res.sendStatus(200);
      }

      await sendTelegramMessage(
        chatId,
        "Please reply with one of: poems, theatre, or common."
      );
      return res.sendStatus(200);
    }

    // /remember
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

    // teacher shortcut
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

    // documents
    if (message.document) {
      const doc = message.document;
      const fileId = doc.file_id;
      const originalName = doc.file_name || `${fileId}.bin`;

      try {
        const localPath = await downloadTelegramFile(
          fileId,
          originalName,
          chatId
        );

        const target = uploadTargetByChat.get(chatId);
        if (target === "onedrive" || target === "gdrive") {
          pendingUploadByChat.set(chatId, {
            path: localPath,
            name: path.basename(localPath),
            target,
          });
          uploadTargetByChat.delete(chatId);

          await sendTelegramMessage(
            chatId,
            "Got your file. Is this *poems*, *theatre*, or *common*?"
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `I saved your file as \`${path.basename(localPath)}\` on the server.`
          );
        }
      } catch (err) {
        console.error("Failed to download/save document:", err);
        await sendTelegramMessage(
          chatId,
          "I got your file but failed to save it. Please try again later."
        );
      }

      return res.sendStatus(200);
    }

    // photos
    if (message.photo && Array.isArray(message.photo) && message.photo.length) {
      const bestPhoto = message.photo[message.photo.length - 1];
      const fileId = bestPhoto.file_id;
      const originalName = `photo_${fileId}.jpg`;

      try {
        const localPath = await downloadTelegramFile(
          fileId,
          originalName,
          chatId
        );

        const target = uploadTargetByChat.get(chatId);
        if (target === "onedrive" || target === "gdrive") {
          pendingUploadByChat.set(chatId, {
            path: localPath,
            name: path.basename(localPath),
            target,
          });
          uploadTargetByChat.delete(chatId);

          await sendTelegramMessage(
            chatId,
            "Got your photo. Is this *poems*, *theatre*, or *common*?"
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `I saved your photo as \`${path.basename(localPath)}\` on the server.`
          );
        }
      } catch (err) {
        console.error("Failed to download/save photo:", err);
        await sendTelegramMessage(
          chatId,
          "I got your photo but failed to save it. Please try again later."
        );
      }

      return res.sendStatus(200);
    }

    // no text and no file
    if (!text) {
      await sendTelegramMessage(
        chatId,
        "I can respond to text, documents, and photos. Try sending a message or a file."
      );
      return res.sendStatus(200);
    }

    // /start
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Hi! Send me a question and I'll ask Perplexity for you."
      );
      return res.sendStatus(200);
    }

    // normal text flow
    await sendChatAction(chatId, "typing");

    const answer = await askPerplexity(text);
    await sendTelegramMessage(chatId, answer);

    // log text
    try {
      const logFile = path.join(DATA_DIR, "messages.log");
      const category = categorizeMemory(text);
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
        await uploadFileToOneDrive(
          logFile,
          "messages.log",
          chatId,
          "Common Files"
        );
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

// ----- Squarespace → Google Workspace route -----

app.post("/squarespace", async (req, res) => {
  try {
    console.log("Incoming Squarespace payload:", JSON.stringify(req.body));

    const firstName = req.body.firstName || req.body["First Name"] || "";
    const lastName = req.body.lastName || req.body["Last Name"] || "";
    const personalEmail = req.body.personalEmail || req.body["Email"] || "";
    const phone = req.body.phone || req.body["Phone"] || "";

    const rawUsername =
      req.body.username ||
      req.body["Username"] ||
      `${firstName}.${lastName}`;

    const username = String(rawUsername)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9.]/g, "");

    if (!firstName || !lastName || !personalEmail || !username) {
      return res.status(400).json({
        error: "missing_fields",
        details: { firstName, lastName, personalEmail, phone, username },
      });
    }

    const user = await createGoogleWorkspaceUser({
      firstName,
      lastName,
      personalEmail,
      phone,
      username,
    });

    return res.status(201).json({ status: "created", user });
  } catch (err) {
    console.error("Squarespace webhook error:", err);
    return res
      .status(500)
      .json({ error: "server_error", message: err.message });
  }
});

// ----- Handle pending upload once user answers type -----

async function handlePendingUploadWithType(chatId, pending, type) {
  try {
    const { path: localPath, name, target } = pending;

    if (target === "onedrive") {
      let kind = "Common Files";
      if (type === "poems") kind = "Poems";
      else if (type === "theatre") kind = "Theatre";

      await uploadFileToOneDrive(localPath, name, chatId, kind);
      await sendTelegramMessage(
        chatId,
        `Uploaded to OneDrive under *${kind}* as \`${name}\`.`
      );
    } else if (target === "gdrive") {
      const folderId = chooseGDriveFolderIdFromType(type);
      await uploadFileToGoogleDrive(localPath, name, chatId, folderId);
      await sendTelegramMessage(
        chatId,
        `Uploaded to Google Drive as *${type}* file \`${name}\`.`
      );
    }
  } catch (err) {
    console.error("Error handling pending upload:", err);
    await sendTelegramMessage(
      chatId,
      "Something went wrong uploading that file. Please try again."
    );
  } finally {
    pendingUploadByChat.delete(chatId);
  }
}

// ----- Memory categorisation -----

function categorizeMemory(text) {
  const t = text.toLowerCase();

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

  if (
    t.includes("theatre") ||
    t.includes("theater") ||
    t.includes("script") ||
    t.includes("scene") ||
    t.includes("monologue") ||
    t.includes("dialogue") ||
    t.includes("character") ||
    t.includes("role") ||
    t.includes("blocking") ||
    t.includes("rehearsal") ||
    t.includes("audition") ||
    t.includes("stage")
  ) {
    return "theatre";
  }

  return "common";
}

// ----- Very simple memory recall -----

function recallFromLog(keyword, preferredCategory = null) {
  try {
    const logFile = path.join(DATA_DIR, "messages.log");
    if (!fs.existsSync(logFile)) return null;

    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.trim().split("\n").reverse();

    for (const line of lines) {
      if (preferredCategory && !line.includes(`category:${preferredCategory}`)) {
        continue;
      }

      const match = line.match(/text:\"(.+?)\"/);
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

// ----- Telegram helpers -----

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

// Upload into /TelegramBot/chat_<id>/
async function uploadFileToOneDrive(
  localPath,
  remoteFileName,
  chatId,
  kind = "Common Files"
) {
  try {
    if (!ONEDRIVE_USER) {
      throw new Error("ONEDRIVE_USER not set");
    }
    if (!chatId) {
      throw new Error("chatId is required for uploadFileToOneDrive");
    }

    const token = await getOneDriveAccessToken();
    const fileBuffer = fs.readFileSync(localPath);

    const baseFolder = ONEDRIVE_FOLDER_PATH;
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

// Create a OneDrive folder via .keep file
async function createOneDriveFolder(folderName, chatId) {
  try {
    if (!ONEDRIVE_USER) throw new Error("ONEDRIVE_USER not set");
    if (!chatId) throw new Error("chatId is required for createOneDriveFolder");

    const token = await getOneDriveAccessToken();
    const buffer = Buffer.from("folder placeholder");

    const baseFolder = ONEDRIVE_FOLDER_PATH;
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

// ----- Google OAuth / Drive helpers -----

function getGoogleOAuthClient() {
  if (
    !GDRIVE_OAUTH_CLIENT_ID ||
    !GDRIVE_OAUTH_CLIENT_SECRET ||
    !GDRIVE_REDIRECT_URI
  ) {
    throw new Error("Google OAuth env vars not set");
  }

  return new google.auth.OAuth2(
    GDRIVE_OAUTH_CLIENT_ID,
    GDRIVE_OAUTH_CLIENT_SECRET,
    GDRIVE_REDIRECT_URI
  );
}

function getGDriveTokenPath() {
  return path.join(DATA_DIR, "gdrive_token.json");
}

function loadSavedGoogleToken() {
  try {
    const tokenPath = getGDriveTokenPath();
    if (!fs.existsSync(tokenPath)) return null;
    const raw = fs.readFileSync(tokenPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load Google token:", err);
    return null;
  }
}

function saveGoogleToken(token) {
  try {
    const tokenPath = getGDriveTokenPath();
    fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), "utf8");
    console.log("Saved Google token to:", tokenPath);
  } catch (err) {
    console.error("Failed to save Google token:", err);
  }
}

function chooseGDriveFolderIdFromType(type) {
  if (type === "poems") {
    return GDRIVE_FOLDER_POEMS || GDRIVE_FOLDER_ID;
  }
  if (type === "theatre") {
    return GDRIVE_FOLDER_THEATRE || GDRIVE_FOLDER_ID;
  }

  return (
    GDRIVE_FOLDER_COMMON_NOTES ||
    GDRIVE_FOLDER_COMMON_IDEAS ||
    GDRIVE_FOLDER_COMMON_MISC ||
    GDRIVE_FOLDER_ID
  );
}

// ----- Google Drive helper -----

async function uploadFileToGoogleDrive(
  localPath,
  remoteFileName,
  chatId,
  folderIdOverride
) {
  try {
    const targetFolderId = folderIdOverride || GDRIVE_FOLDER_ID;
    if (!targetFolderId) {
      throw new Error("GDRIVE_FOLDER_ID not set");
    }

    const tokens = loadSavedGoogleToken();
    if (!tokens || !tokens.refresh_token) {
      console.error("No Google refresh token stored yet.");
      return;
    }

    const oAuth2Client = getGoogleOAuthClient();
    oAuth2Client.setCredentials(tokens);

    const drive = google.drive({ version: "v3", auth: oAuth2Client });

    const fileMetadata = {
      name: remoteFileName,
      parents: [targetFolderId],
    };

    const media = {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(localPath),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    console.log(
      `Uploaded to Google Drive (chat ${chatId}) in folder ${targetFolderId}:`,
      response.data.id,
      response.data.webViewLink
    );
  } catch (err) {
    console.error("Failed to upload to Google Drive:", err);
  }
}

// ----- Google Workspace user helper (service account JWT) -----

async function createGoogleWorkspaceUser({
  firstName,
  lastName,
  personalEmail,
  phone,
  username,
}) {
  if (!SA_CLIENT_EMAIL || !SA_PRIVATE_KEY || !ADMIN_IMPERSONATE) {
    throw new Error("Service account env vars not configured");
  }

  const scopes = ["https://www.googleapis.com/auth/admin.directory.user"];
  const jwtClient = new google.auth.JWT(
    SA_CLIENT_EMAIL,
    null,
    SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes,
    ADMIN_IMPERSONATE
  );

  const tokens = await jwtClient.authorize();
  const accessToken = tokens.access_token;
  if (!accessToken) {
    throw new Error("Failed to obtain access token from service account");
  }

  const safeUsername = String(username)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9.]/g, "");

  const primaryEmail = `${safeUsername}@${ORG_DOMAIN}`;

  const body = {
    primaryEmail,
    name: {
      givenName: firstName,
      familyName: lastName,
      fullName: `${firstName} ${lastName}`.trim(),
    },
    password: "TempPass123!",
    changePasswordAtNextLogin: true,
    orgUnitPath: "/Guests",
    suspended: false,
    recoveryEmail: personalEmail,
    recoveryPhone: phone,
    phones: [
      {
        type: "work",
        value: phone,
        primary: true,
      },
    ],
    notes: {
      value:
        "Guest account – intended for Google Meet only. Place in /Guests OU and restrict services there.",
      contentType: "plainText",
    },
    agreedToTerms: true,
    ipWhitelisted: false,
  };

  console.log("Creating Google user:", body);

  const resp = await fetch(
    "https://admin.googleapis.com/admin/directory/v1/users",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Google Admin error:", text);
    throw new Error(`Google Admin error: ${text}`);
  }

  const user = await resp.json();
  console.log("Created Google user:", user);
  return user;
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
