import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Danh sách từ khóa của bạn
const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- 1. HÀM TẢI EXCEL LÊN LITTERBOX (CATBOX) ---
async function uploadToCatbox(filePath) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', fs.createReadStream(filePath));

        const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
            headers: form.getHeaders()
        });

        const fileLink = response.data.trim();
        if (fileLink.includes('https://')) return fileLink;
        return "";
    } catch (error) {
        console.error("❌ Lỗi Litterbox:", error.message);
        return "";
    }
}

// --- 2. HÀM GỬI THÔNG BÁO VÀO MICROSOFT TEAMS ---
async function sendToTeams(totalJobs, fileLink) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl || !fileLink) return;

    const adaptiveCard = {
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": "🚀 CẬP NHẬT JOB DICE - BURNABY", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            {
                "type": "FactSet",
                "facts": [
                    { "title": "Số lượng:", "value": `${totalJobs} jobs` },
                    { "title": "Khu vực:", "value": "Burnaby, Canada" }
                ]
            }
        ],
        "actions": [
            { "type": "Action.OpenUrl", "title": "📥 TẢI FILE EXCEL", "url": fileLink }
        ],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
    };

    try {
        await axios.post(webhookUrl, adaptiveCard);
        console.log("✅ Đã gửi thông báo tới Teams thành công.");
    } catch (error) {
        console.error("❌ Lỗi gửi Teams:", error.message);
    }
}

// --- 3. HÀM GỬI THÔNG BÁO QUA TELEGRAM ---
async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) { console.error("❌ Lỗi gửi Telegram:", e.message); }
}

async function sendTelegramFile(filePath) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId || !fs.existsSync(filePath)) return;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath));
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, form, {
            headers: form.getHeaders()
        });
        console.log("✅ Đã gửi file qua Telegram thành công.");
    } catch (e) { console.error("❌ Lỗi gửi file Telegram:", e.message); }
}

// --- 4. HÀM CHẠY QUÉT DỮ LIỆU ---
async function runScraper() {
    console.log("🚀 Khởi động quét Dice.com (Burnaby & Canada)...");
    let allJobs = [];

    for (const kw of KEYWORDS) {
        // Địa điểm chính xác theo ảnh bạn gửi
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Burnaby,%20BC,%20Canada`;
        
        try {
            console.log(`🔍 Đang quét từ khóa: ${kw}`);
            const response = await axios.get('http://api.scraperapi.com', {
                params: {
                    api_key: process.env.SCRAPER_API_KEY,
                    url: targetUrl,
                    render: 'true',
                    ultra_premium: 'true', // Dùng chế độ mạnh nhất để phá 403
                    country_code: 'ca',
                    wait: 15000            // Chờ 15s để load lương $50+
                },
                timeout: 240000 
            });

            const $ = cheerio.load(response.data);
            let count = 0;

            // Bộ chọn dựa trên ID position-x mà bạn đã Inspect thấy
            $('a[id^="position-"]').each((i, el) => {
                const title = $(el).text().trim();
                let link = $(el).attr('href');
                if (link && !link.startsWith('http')) link = `https://www.dice.com${link}`;

                const card = $(el).closest('dhi-search-card');
                const company = card.find('[data-cy="search-result-company-name"]').text().trim() || "N/A";
                const location = card.find('[data-cy="search-result-location"]').text().trim() || "Burnaby, BC";

                // Bóc tách mức lương ($50+)
                let salary = "N/A";
                card.find('span, dhi-badge, div').each((j, s) => {
                    const txt = $(s).text().trim();
                    if (txt.includes('$')) { salary = txt; return false; }
                });

                allJobs.push({
                    "Tiêu đề": title,
                    "Công ty": company,
                    "Địa điểm": location,
                    "Mức lương": salary,
                    "Đường dẫn": link
                });
                count++;
            });

            console.log(`   ✅ Thành công: ${count} jobs cho ${kw}`);
            await new Promise(r => setTimeout(r, 4000));

        } catch (error) {
            console.error(`   ❌ Lỗi tại ${kw}: ${error.message}`);
            if (error.response && error.response.status === 403) {
                console.log("   👉 CẢNH BÁO: ScraperAPI chặn. Kiểm tra số dư Credits ngay!");
            }
        }
    }

    if (allJobs.length > 0) {
        const fileName = `Dice_Burnaby_Report.xlsx`;
        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        const fileLink = await uploadToCatbox(fileName);
        
        await Promise.all([
            sendTelegramAlert(`✅ Dice.com Scraper hoàn tất! Tìm thấy ${allJobs.length} jobs tại Burnaby.`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);
        console.log("🏁 Hoàn tất gửi dữ liệu.");
    } else {
        console.log("⚠️ Không có dữ liệu để gửi.");
    }
}

runScraper();