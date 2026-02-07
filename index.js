// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// -------------------------------------------------------------
// CONFIGURATION
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
// CRITICAL: Ensure this is set in your .env (e.g., https://your-app.onrender.com)
const SERVER_URL = process.env.SERVER_URL; 
const MONGODB_URI = process.env.MONGODB_URI;

// -------------------------------------------------------------
// DATABASE CONNECTION
// -------------------------------------------------------------
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  
  if (!MONGODB_URI) throw new Error("MONGODB_URI is missing");

  const conn = await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000 
  });
  
  cachedDb = conn;
  console.log("✅ New MongoDB Connection Created");
  return conn;
}

// --- MODELS (Defined at the top) ---

// 1. PIN Model (Auto-deletes after 10 mins)
const fileSchema = new mongoose.Schema({
  pin: String,
  whatsapp_id: String,
  filename: String,
  mime_type: String,
  sender_mobile: String,
  extension: String,
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 600 // Note: This means the link expires in 10 mins!
  } 
});
const FileModel = mongoose.models.File || mongoose.model('File', fileSchema);

// 2. History Model (For Flutter App - No Auto Delete)
const fileHistorySchema = new mongoose.Schema({
  url: String,       
  pathname: String,  
  messageId: String, 
  createdAt: { type: Date, default: Date.now }
});
const FileHistoryModel = mongoose.models.FileHistory || mongoose.model('FileHistory', fileHistorySchema);

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function sendMessage(phoneId, to, textBody) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${phoneId}/messages`, 
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: textBody }
      },
      { 
        headers: { 
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        } 
      }
    );
    console.log(`📤 Message sent to ${to}`);
  } catch (err) {
    console.error("❌ Failed to send WhatsApp message:", err.message);
  }
}

// -------------------------------------------------------------
// 1. WEB UI (Dashboard)
// -------------------------------------------------------------
app.get('/', async (req, res) => {
  try {
    await connectToDatabase();
    const files = await FileModel.find().sort({ createdAt: -1 });

    const fileRows = files.map(file => `
      <tr class="hover:bg-gray-50 border-b transition">
        <td class="px-6 py-4">
          <span class="bg-green-100 text-green-800 font-mono font-bold px-3 py-1 rounded">${file.pin}</span>
        </td>
        <td class="px-6 py-4 text-gray-700 font-medium">${file.filename || 'Unknown'}</td>
        <td class="px-6 py-4 text-gray-500 text-sm">${new Date(file.createdAt).toLocaleTimeString()}</td>
        <td class="px-6 py-4">
          <a href="/download/${file.pin}" target="_blank" class="text-green-600 hover:text-green-900 font-medium">Download</a>
        </td>
      </tr>
    `).join('');

    // (Simplified HTML for brevity, keep your original HTML if you prefer)
    res.send(`<html><body><h1>Active Files: ${files.length}</h1><table>${fileRows}</table></body></html>`);
  } catch (error) {
    res.status(500).send("Dashboard Error: " + error.message);
  }
});

// -------------------------------------------------------------
// 2. WEBHOOK (UPDATED FIX)
// -------------------------------------------------------------
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (!body.object) return res.sendStatus(404);

  try {
    const changes = body.entry?.[0]?.changes?.[0]?.value;
    if (!changes || !changes.messages) return res.sendStatus(200);

    const message = changes.messages[0];
    const businessPhoneId = changes.metadata.phone_number_id;
    const from = message.from;
    const msgType = message.type;

    await connectToDatabase();

    if (msgType === "text") {
      await sendMessage(businessPhoneId, from, "👋 Send a Document/Photo to get a PIN.");
    } 
    else if (msgType === "document" || msgType === "image") {
      console.log(`📂 Received ${msgType} from ${from}`);

      const mediaId = msgType === "document" ? message.document.id : message.image.id;
      const originalName = msgType === "document" ? message.document.filename : `photo_${mediaId}.jpg`;
      const mimeType = msgType === "document" ? message.document.mime_type : message.image.mime_type;
      
      let ext = ".bin";
      if (msgType === "image") ext = ".jpg";
      else if (mimeType === "application/pdf") ext = ".pdf";
      else if (originalName.includes(".")) ext = path.extname(originalName);

      const pin = generatePin();

      // A. SAVE TO PIN MODEL (For Web UI)
      await FileModel.create({
        pin: pin,
        whatsapp_id: mediaId,
        filename: originalName,
        mime_type: mimeType,
        sender_mobile: from,
        extension: ext
      });

      // B. SAVE TO HISTORY MODEL (For Flutter App) - THE FIX
      // We construct a URL that points to THIS server's download route
      const downloadUrl = `${SERVER_URL}/download/${pin}`;

      await FileHistoryModel.create({
        url: downloadUrl,
        pathname: originalName,
        messageId: mediaId
      });

      console.log(`✅ Saved PIN: ${pin} | History URL: ${downloadUrl}`);
      
      await sendMessage(businessPhoneId, from, `✅ *File Saved!*\n\nPIN: *${pin}*\nExpires in 10 mins.`);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
    res.sendStatus(200); 
  }
});

// -------------------------------------------------------------
// 3. DOWNLOAD & UTILS
// -------------------------------------------------------------
app.get("/download/:pin", async (req, res) => {
  try {
    await connectToDatabase();
    const { pin } = req.params;
    
    // Find in FileModel
    const file = await FileModel.findOne({ pin: pin });

    if (!file) return res.status(404).send("File not found or expired (10 min limit).");

    // Get URL from WhatsApp
    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${file.whatsapp_id}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    // Stream the file content to the user
    const fileResponse = await axios({
      method: 'get',
      url: urlResponse.data.url,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    const downloadName = file.filename || `${file.pin}${file.extension}`;
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error("Download Error:", error.message);
    res.status(500).send("Error fetching file.");
  }
});

// Endpoint for Flutter App
app.get('/api/files', async (req, res) => {
  try {
    await connectToDatabase();
    // Fetch newest 50 files
    const files = await FileHistoryModel.find().sort({ createdAt: -1 }).limit(50);
    
    const response = files.map(file => ({
      url: file.url,
      pathname: file.pathname,
      date: file.createdAt
    }));

    res.json(response);
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/clear-all', async (req, res) => {
  await connectToDatabase();
  await FileModel.deleteMany({});
  await FileHistoryModel.deleteMany({}); // Clear history too
  res.redirect('/');
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
