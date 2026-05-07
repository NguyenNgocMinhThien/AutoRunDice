import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- HÀM UPLOAD (GIỮ NGUYÊN) ---
async function uploadToCatbox(filePath) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', fs.createReadStream(filePath));
        const res = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, { headers: form.getHeaders() });
        return res.data.trim();
    } catch (e) { return ""; }
}

// --- HÀM GỬI TEAMS & TELEGRAM (GIỮ NGUYÊN) ---
async function sendTelegramAlert(msg) {
    const token = process.env.TELEGRAM_TOKEN;
    const id = process.env.TELEGRAM_CHAT_ID;
    if (!token || !id) return;
    try { await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: id, text: msg, parse_mode: 'HTML' }); } catch (e) {}
}

async function sendTelegramFile(path) {
    const token = process.env.TELEGRAM_TOKEN;
    const id = process.env.TELEGRAM_CHAT_ID;
    if (!token || !id || !fs.existsSync(path)) return;
    const form = new FormData();
    form.append('chat_id', id);
    form.append('document', fs.createReadStream(path));
    try { await axios.post(`https://api.telegram.org/bot${token}/sendDocument`, form, { headers: form.getHeaders() }); } catch (e) {}
}

// --- HÀM CHẠY CHÍNH (SỬA LẠI ĐỂ CHỐNG CHẶN) ---
async function runScraper() {
    console.log("🚀 Đang khởi động lại quy trình quét...");
    let allJobs = [];

    for (const kw of KEYWORDS) {
        // Location để "Canada" cho rộng kết quả
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Canada`;
        
        try {
            console.log(`🔍 Đang thử quét từ khóa: ${kw}`);
            const response = await axios.get('http://api.scraperapi.com', {
                params: {
                    api_key: process.env.SCRAPER_API_KEY,
                    url: targetUrl,
                    render: 'true',       // BẮT BUỘC để đọc được thẻ position-
                    premium: 'true',      // BẮT BUỘC để vượt lỗi 403
                    country_code: 'ca',
                    wait: 10000           // Giảm xuống 10s để tránh lỗi 500 do chờ quá lâu
                },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                }
            });

            const $ = cheerio.load(response.data);
            let count = 0;

            // Dùng bộ chọn ID position mà bạn đã inspect thành công
            $('a[id^="position-"]').each((i, el) => {
                const title = $(el).text().trim();
                let link = $(el).attr('href');
                if (link && !link.startsWith('http')) link = `https://www.dice.com${link}`;

                const card = $(el).closest('dhi-search-card, [class*="card"]');
                const company = card.find('[data-cy="search-result-company-name"]').text().trim() || "N/A";
                const location = card.find('[data-cy="search-result-location"]').text().trim() || "Canada";
                
                // Bắt mức lương $50+ như trong hình bạn chụp
                let salary = "N/A";
                card.find('span, div, dhi-badge').each((j, s) => {
                    const txt = $(s).text().trim();
                    if (txt.includes('$')) { salary = txt; return false; }
                });

                allJobs.push({ "Title": title, "Company": company, "Location": location, "Salary": salary, "Link": link });
                count++;
            });

            console.log(`✅ Thành công: ${count} jobs.`);
            await new Promise(r => setTimeout(r, 3000)); // Nghỉ ngắn tránh bị khóa

        } catch (error) {
            console.error(`❌ Lỗi 403/500 tại ${kw}: ${error.message}`);
        }
    }

    if (allJobs.length > 0) {
        const fileName = `Dice_Jobs_Final.xlsx`;
        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);
        
        const fileLink = await uploadToCatbox(fileName);
        await sendTelegramAlert(`✅ Đã hồi phục! Tìm thấy ${allJobs.length} jobs.`);
        await sendTelegramFile(fileName);
    } else {
        console.log("⚠️ Vẫn không có dữ liệu. Kiểm tra lại Credits của ScraperAPI!");
    }
}

runScraper();