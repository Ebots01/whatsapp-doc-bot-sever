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
const SERVER_URL = process.env.SERVER_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// -------------------------------------------------------------
// DATABASE CONNECTION (Robust)
// -------------------------------------------------------------
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  
  if (!MONGODB_URI) throw new Error("MONGODB_URI is missing");

  // Allow Mongoose to buffer commands (prevents "Cannot call find()" error)
  const conn = await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000 // Fail fast if DB is down
  });
  
  cachedDb = conn;
  console.log("✅ New MongoDB Connection Created");
  return conn;
}

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
    expires: 600 // Auto-delete after 10 mins
  } 
});

const FileModel = mongoose.models.File || mongoose.model('File', fileSchema);

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
    // Sort by newest first
    const files = await FileModel.find().sort({ createdAt: -1 });

    const fileRows = files.map(file => `
      <tr class="hover:bg-gray-50 border-b transition">
        <td class="px-6 py-4">
          <div class="flex items-center">
            <span class="bg-green-100 text-green-800 text-lg font-mono font-bold px-3 py-1 rounded border border-green-200">${file.pin}</span>
          </div>
        </td>
        <td class="px-6 py-4 text-gray-700 font-medium">${file.filename || 'Unknown'}</td>
        <td class="px-6 py-4 text-gray-500 text-sm">${new Date(file.createdAt).toLocaleTimeString()}</td>
        <td class="px-6 py-4">
          <a href="/download/${file.pin}" target="_blank" class="inline-flex items-center px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-md transition shadow-sm">
            Download
          </a>
        </td>
      </tr>
    `).join('');

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Media Gateway</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <meta http-equiv="refresh" content="30">
      </head>
      <body class="bg-gray-50 min-h-screen font-sans">
        <div class="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
          <div class="bg-white rounded-xl shadow-xl overflow-hidden ring-1 ring-black ring-opacity-5">
            <div class="bg-[#075E54] px-8 py-6 flex justify-between items-center">
              <div>
                <h1 class="text-2xl font-bold text-white tracking-tight">Media Gateway</h1>
                <p class="text-teal-100 text-sm mt-1">Live MongoDB Storage</p>
              </div>
              <div class="bg-white/10 px-4 py-2 rounded-lg backdrop-blur-sm border border-white/20">
                <span class="text-white font-mono font-bold text-xl">${files.length}</span>
                <span class="text-teal-100 text-sm ml-1">Files</span>
              </div>
            </div>
            
            <div class="overflow-x-auto">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PIN Code</th>
                    <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Filename</th>
                    <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                    <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  ${files.length > 0 ? fileRows : 
                    '<tr><td colspan="4" class="px-6 py-12 text-center text-gray-400 italic">No active files found.<br>Send a document to your bot to start.</td></tr>'}
                </tbody>
              </table>
            </div>
            
            <div class="bg-gray-50 px-6 py-4 border-t border-gray-200 flex justify-center">
               <form action="/api/clear-all" method="POST">
                 <button type="submit" class="text-xs text-red-500 hover:text-red-700 font-medium transition uppercase tracking-wide">
                   ⚠️ Clear Database
                 </button>
               </form>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send("Dashboard Error: " + error.message);
  }
});

// -------------------------------------------------------------
// 2. WEBHOOK (Logic Fixed)
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

  if (!body.object) {
    return res.sendStatus(404);
  }

  try {
    const changes = body.entry?.[0]?.changes?.[0]?.value;
    if (!changes || !changes.messages) {
      return res.sendStatus(200);
    }

    const message = changes.messages[0];
    const businessPhoneId = changes.metadata.phone_number_id;
    const from = message.from;
    const msgType = message.type;

    // Connect DB *before* processing to ensure we are ready
    await connectToDatabase();

    // Handle TEXT
    if (msgType === "text") {
      await sendMessage(businessPhoneId, from, "👋 Send a Document or Photo to get a 4-digit PIN.");
    } 
    // Handle MEDIA
    else if (msgType === "document" || msgType === "image") {
      console.log(`📂 Received ${msgType} from ${from}`);

      const mediaId = msgType === "document" ? message.document.id : message.image.id;
      const originalName = msgType === "document" ? message.document.filename : "photo";
      const mimeType = msgType === "document" ? message.document.mime_type : message.image.mime_type;
      
      let ext = ".bin";
      if (msgType === "image") ext = ".jpg";
      else if (mimeType === "application/pdf") ext = ".pdf";
      else if (originalName.includes(".")) ext = path.extname(originalName);

      const pin = generatePin();

      // SAVE TO DB FIRST
      await FileModel.create({
        pin: pin,
        whatsapp_id: mediaId,
        filename: originalName,
        mime_type: mimeType,
        sender_mobile: from,
        extension: ext
      });

      console.log(`✅ Saved with PIN: ${pin}`);
      
      // SEND REPLY
      await sendMessage(businessPhoneId, from, `✅ *File Saved!*\n\nPIN: *${pin}*\nExpires in 10 mins.`);
    }

    // SUCCESS - Send 200 OK ONLY AFTER everything is done
    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
    // Send 200 anyway so WhatsApp doesn't keep retrying and banning us
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
    const file = await FileModel.findOne({ pin: pin });

    if (!file) return res.status(404).send("File not found or expired.");

    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${file.whatsapp_id}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    const fileResponse = await axios({
      method: 'get',
      url: urlResponse.data.url,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    const downloadName = `${file.pin}${file.extension}`;
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error("Download Error:", error.message);
    res.status(500).send("Error fetching file.");
  }
});

app.post('/api/clear-all', async (req, res) => {
  await connectToDatabase();
  await FileModel.deleteMany({});
  res.redirect('/');
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));