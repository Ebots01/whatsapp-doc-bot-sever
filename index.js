const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { put, list } = require("@vercel/blob"); 
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Credentials from Environment Variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 

// --- FEATURE 1: Home Page to View Files (http://your-site.vercel.app/) ---
app.get("/", async (req, res) => {
  try {
    const { blobs } = await list({ token: process.env.BLOB_READ_WRITE_TOKEN });
    
    let html = `
      <html>
        <head>
            <title>My WhatsApp Docs</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family: sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto;">
          <h1>📂 Received Documents</h1>
          <p>Total files: ${blobs.length}</p>
          <ul style="list-style: none; padding: 0;">
    `;

    blobs.forEach(blob => {
      html += `
        <li style="margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
          <a href="${blob.url}" target="_blank" style="text-decoration: none; color: #0070f3; font-weight: bold;">
            📄 ${blob.pathname}
          </a> 
          <br>
          <span style="color: gray; font-size: 0.8em;">Saved on: ${new Date(blob.uploadedAt).toLocaleString()}</span>
        </li>`;
    });

    html += `</ul></body></html>`;
    res.send(html);

  } catch (error) {
    res.send(`<h1>Error loading files</h1><p>${error.message}</p>`);
  }
});

// --- FEATURE 2: Webhook Verification (Required by Meta) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook Verified Successfully!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- FEATURE 3: Receive Messages (The Bot Logic) ---
app.post("/webhook", async (req, res) => {
  const body = req.body;
  
  // 1. Check if it's a valid WhatsApp message
  if (!body.object) return res.sendStatus(404);

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from; // User's phone number
      const msgType = message.type;
      
      // Determine which Phone ID to send from (Env Var or Automatic)
      const businessPhoneId = PHONE_NUMBER_ID || value.metadata.phone_number_id;

      console.log(`📩 Message received from ${from} [Type: ${msgType}]`);

      // Mark as Read
      await markAsRead(businessPhoneId, message.id);

      // --- CASE A: TEXT MESSAGE ---
      if (msgType === "text") {
        await sendMessage(businessPhoneId, from, "👋 Hello! I am your Document Bot.\n\nSend me a PDF or Photo, and I will save it to the server for you.");
      } 
      
      // --- CASE B: DOCUMENT or IMAGE ---
      else if (msgType === "document" || msgType === "image") {
        
        // 1. Determine File ID and Name
        let mediaId, originalName;
        
        if (msgType === "document") {
            mediaId = message.document.id;
            originalName = message.document.filename || "document.pdf";
        } else {
            mediaId = message.image.id;
            originalName = "photo.jpg"; // Images don't always have names, so we give a default
        }

        // 2. Create a unique filename (adds timestamp to prevent duplicates)
        // Example: "my-resume.pdf" -> "170456789_my-resume.pdf"
        const cleanName = originalName.replace(/\s+/g, '_');
        const uniqueFileName = `${Date.now()}_${cleanName}`;

        console.log(`📥 Downloading ${msgType}...`);

        // 3. Get the Download URL from Meta
        const urlRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        
        // 4. Download the binary data
        const imgRes = await axios.get(urlRes.data.url, {
          responseType: "arraybuffer",
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });

        // 5. Save to Vercel Blob (Permanent Storage)
        const blob = await put(uniqueFileName, imgRes.data, {
          access: 'public',
          token: process.env.BLOB_READ_WRITE_TOKEN
        });

        console.log(`✅ Saved at: ${blob.url}`);

        // 6. Send "Thank You" Reply
        await sendMessage(businessPhoneId, from, `✅ Received! \n\nI have saved your ${msgType} securely.\n\n📂 View it here: ${blob.url}`);
      }
    }
    res.sendStatus(200);

  } catch (error) {
    console.error("❌ ERROR:", error.message);
    if(error.response) console.error("Details:", JSON.stringify(error.response.data, null, 2));
    res.sendStatus(500);
  }
});

// --- HELPER FUNCTIONS ---

async function sendMessage(phoneId, to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("Failed to send reply:", err.message);
  }
}

async function markAsRead(phoneId, messageId) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            { messaging_product: "whatsapp", status: "read", message_id: messageId },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
    } catch (e) { /* Ignore read receipt errors */ }
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));