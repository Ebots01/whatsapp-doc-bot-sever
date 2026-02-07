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
const SERVER_URL = process.env.SERVER_URL; // e.g. https://your-app.onrender.com
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
  console.log("✅ MongoDB Connected");
  return conn;
}

// --- MODELS ---

// 1. PIN Model (Auto-deletes after 24 hours for safety)
const fileSchema = new mongoose.Schema({
  pin: String,
  whatsapp_id: String,
  filename: String, // NOW STORES: 1234.pdf
  original_name: String, // Stores the user's original filename just in case
  mime_type: String,
  sender_mobile: String,
  extension: String,
  createdAt: { type: Date, default: Date.now, expires: 86400 } // 24 hours
});
const FileModel = mongoose.models.File || mongoose.model('File', fileSchema);

// 2. History Model (For Flutter App - Permanent Log)
const fileHistorySchema = new mongoose.Schema({
  url: String,       
  pathname: String,  // NOW STORES: 1234.pdf
  original_name: String,
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
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Send Message Error:", err.message);
  }
}

// -------------------------------------------------------------
// 1. NEW SERVER UI (Dashboard)
// -------------------------------------------------------------
app.get('/', async (req, res) => {
  try {
    await connectToDatabase();
    // Fetch last 20 files
    const files = await FileModel.find().sort({ createdAt: -1 }).limit(20);

    const rows = files.map(file => `
      <tr class="border-b hover:bg-slate-50 transition-colors">
        <td class="p-4">
          <span class="inline-block px-3 py-1 bg-blue-100 text-blue-800 rounded-full font-mono font-bold text-sm">
            ${file.pin}
          </span>
        </td>
        <td class="p-4 font-medium text-slate-700">
          ${file.filename} <br>
          <span class="text-xs text-slate-400 font-normal">(${file.original_name})</span>
        </td>
        <td class="p-4 text-slate-500 text-sm">
          ${new Date(file.createdAt).toLocaleTimeString()}
        </td>
        <td class="p-4">
          <a href="/download/${file.pin}" target="_blank" 
             class="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm hover:shadow-md">
             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
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
        <title>WhatsApp Bot Server</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>body { font-family: 'Inter', sans-serif; }</style>
        <meta http-equiv="refresh" content="5"> 
      </head>
      <body class="bg-slate-100 min-h-screen p-6 md:p-12">
        <div class="max-w-5xl mx-auto">
          <div class="bg-white rounded-2xl shadow-xl overflow-hidden mb-8 border border-slate-200">
            <div class="bg-[#0f172a] p-8 flex flex-col md:flex-row justify-between items-center">
              <div>
                <h1 class="text-3xl font-bold text-white mb-2">Bot Dashboard</h1>
                <p class="text-slate-400">Live monitor of processed documents</p>
              </div>
              <div class="mt-6 md:mt-0 flex gap-4">
                <div class="text-center px-6 py-3 bg-white/10 rounded-xl backdrop-blur-sm border border-white/10">
                  <div class="text-2xl font-bold text-white">${files.length}</div>
                  <div class="text-xs text-slate-400 uppercase tracking-wider">Active Files</div>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead class="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th class="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">PIN Code</th>
                    <th class="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Filename (New / Old)</th>
                    <th class="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Time</th>
                    <th class="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${files.length > 0 ? rows : `<tr><td colspan="4" class="p-8 text-center text-slate-400">No files received yet. Waiting for WhatsApp...</td></tr>`}
                </tbody>
              </table>
            </div>
            
            <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
               <form action="/api/clear-all" method="POST" onsubmit="return confirm('Delete all files?');">
                 <button type="submit" class="text-red-600 hover:text-red-800 text-sm font-semibold flex items-center gap-2 px-4 py-2 rounded hover:bg-red-50 transition">
                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                   Clear History
                 </button>
               </form>
            </div>
          </div>
          
          <div class="mt-8 text-center text-slate-400 text-sm">
            Auto-refreshing every 5 seconds • Files expire in 24 hours
          </div>
        </div>
      </body>
      </html>
    `;
    res.send(html);
  } catch (error) {
    res.status(500).send("UI Error: " + error.message);
  }
});

// -------------------------------------------------------------
// 2. WEBHOOK (Logic Changed: Rename to PIN.ext)
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
      await sendMessage(businessPhoneId, from, "👋 Send a Document or Photo to get a PIN.");
    } 
    else if (msgType === "document" || msgType === "image") {
      console.log(`📂 Received ${msgType} from ${from}`);

      const mediaId = msgType === "document" ? message.document.id : message.image.id;
      const originalRawName = msgType === "document" ? message.document.filename : `photo_${mediaId}`;
      const mimeType = msgType === "document" ? message.document.mime_type : message.image.mime_type;
      
      // 1. Determine Extension
      let ext = ".bin";
      if (msgType === "image") ext = ".jpg";
      else if (mimeType === "application/pdf") ext = ".pdf";
      else if (originalRawName.includes(".")) ext = path.extname(originalRawName);

      // 2. Generate PIN
      const pin = generatePin();

      // 3. Create NEW Filename (1234.pdf)
      const pinFilename = `${pin}${ext}`;

      // A. Save to Active PIN Model
      await FileModel.create({
        pin: pin,
        whatsapp_id: mediaId,
        filename: pinFilename,       // Saved as 1234.pdf
        original_name: originalRawName, // Keep original just in case
        mime_type: mimeType,
        sender_mobile: from,
        extension: ext
      });

      // B. Save to History Model (For Flutter)
      const downloadUrl = `${SERVER_URL}/download/${pin}`;

      await FileHistoryModel.create({
        url: downloadUrl,
        pathname: pinFilename, // Flutter will see "1234.pdf"
        original_name: originalRawName,
        messageId: mediaId
      });

      console.log(`✅ Saved: ${pinFilename}`);
      
      await sendMessage(businessPhoneId, from, `✅ *File Saved!*\n\nPIN: *${pin}*\nFile: ${pinFilename}`);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
    res.sendStatus(200); 
  }
});

// -------------------------------------------------------------
// 3. DOWNLOAD (Serves file as 1234.pdf)
// -------------------------------------------------------------
app.get("/download/:pin", async (req, res) => {
  try {
    await connectToDatabase();
    const { pin } = req.params;
    
    const file = await FileModel.findOne({ pin: pin });
    if (!file) return res.status(404).send("File not found or expired.");

    // Get direct link from WhatsApp API
    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${file.whatsapp_id}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    const fileResponse = await axios({
      method: 'get',
      url: urlResponse.data.url,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    // Force download with the PIN filename (e.g., 1234.pdf)
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error("Download Error:", error.message);
    res.status(500).send("Error fetching file.");
  }
});

// API for Flutter
app.get('/api/files', async (req, res) => {
  try {
    await connectToDatabase();
    const files = await FileHistoryModel.find().sort({ createdAt: -1 }).limit(50);
    
    const response = files.map(file => ({
      url: file.url,
      pathname: file.pathname, // This is now "1234.pdf"
      date: file.createdAt
    }));

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/clear-all', async (req, res) => {
  await connectToDatabase();
  await FileModel.deleteMany({});
  await FileHistoryModel.deleteMany({});
  res.redirect('/');
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
