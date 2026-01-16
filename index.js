const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { put, list } = require("@vercel/blob");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// 1. WEBHOOK VERIFICATION (The Handshake)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook Verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. RECEIVE & REPLY (The Bot Logic)
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Check if it's a valid WhatsApp message
  if (!body.object) return res.sendStatus(404);

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // CRITICAL: Get the Phone Number ID that received the message
    // This ensures your bot works even if you have multiple numbers later
    const businessPhoneId = value?.metadata?.phone_number_id;

    if (message) {
      const from = message.from; // The user's phone number
      const msgType = message.type;

      // --- LOGIC: Handle Text ---
      if (msgType === "text") {
        console.log(`📩 Received text from ${from}`);
        // Passing businessPhoneId ensures the reply comes from the correct number
        await sendMessage(businessPhoneId, from, "I received your text! Send me a PDF or Photo to save it.");
      } 
      
      // --- LOGIC: Handle Documents & Images ---
      else if (msgType === "document" || msgType === "image") {
        console.log(`📂 Received ${msgType} from ${from}`);

        // 1. Get Media ID
        const mediaId = msgType === "document" ? message.document.id : message.image.id;
        const defaultName = msgType === "document" ? message.document.filename : "photo.jpg";
        
        // 2. Create Unique Filename
        const fileName = `${Date.now()}_${defaultName.replace(/\s+/g, '_')}`;

        // 3. Get Media URL (Using v24.0)
        const urlRes = await axios.get(`https://graph.facebook.com/v24.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
        });

        // 4. Download File
        const fileRes = await axios.get(urlRes.data.url, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
        });

        // 5. Save to Vercel Blob
        const blob = await put(fileName, fileRes.data, {
            access: 'public',
            token: process.env.BLOB_READ_WRITE_TOKEN
        });

        // 6. Reply to User
        await sendMessage(businessPhoneId, from, `✅ Saved! View here: ${blob.url}`);
      }
    }
    res.sendStatus(200);

  } catch (error) {
    // Better error logging to see API response details
    console.error("❌ Error:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    res.sendStatus(500);
  }
});

// --- HELPER: Send Message ---
async function sendMessage(phoneId, to, textBody) {
  // FALLBACK: If phoneId wasn't captured from webhook, use the env variable
  const senderId = phoneId || process.env.PHONE_NUMBER_ID; 

  try {
    await axios.post(
      `https://graph.facebook.com/v24.0/${senderId}/messages`, 
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: textBody }
      },
      { 
        headers: { 
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        } 
      }
    );
  } catch (err) {
    console.error("Failed to send message:", err.response ? err.response.data : err.message);
  }
}

// --- FEATURE: View Files on Home Page ---
app.get("/", async (req, res) => {
    try {
        const { blobs } = await list({ token: process.env.BLOB_READ_WRITE_TOKEN });
        res.json(blobs); 
    } catch (e) { res.send("Error loading files"); }
});

app.listen(PORT, () => console.log(`Server v24.0 running on port ${PORT}`));