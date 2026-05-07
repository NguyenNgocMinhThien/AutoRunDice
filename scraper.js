import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Danh sách từ khóa tìm kiếm đầy đủ
const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- HÀM TẢI FILE LÊN LITTERBOX (CATBOX) ---
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
        if (fileLink.includes('https://')) {
            return fileLink;
        }
        throw new Error("Không nhận được link từ Catbox");
    } catch (error) {
        console.error("❌ Lỗi Catbox:", error.message);
        return "";
    }
}

// --- HÀM GỬI THÔNG BÁO VÀO MICROSOFT TEAMS ---
async function sendToTeams(totalJobs, fileLink) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    const adaptiveCard = {
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": "🚀 CẬP NHẬT JOB TỪ DICE.COM", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            {
                "type": "FactSet",
                "facts": [
                    { "title": "Khu vực:", "value": "Burnaby & Canada" },
                    { "title": "Số lượng:", "value": `${totalJobs} jobs` }
                ]
            }
        ],
        "actions": [
            { "type": "Action.OpenUrl", "title": "📥 Tải File Excel", "url": fileLink }
        ],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
    };

    try {
        await axios.post(webhookUrl, adaptiveCard);
        console.log("✅ Đã gửi thông báo tới Teams!");
    } catch (error) {
        console.error("❌ Lỗi Teams:", error.message);
    }
}

// --- HÀM GỬI THÔNG BÁO QUA TELEGRAM ---
async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) { console.error("❌ Lỗi Telegram Message:", e.message); }
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
        console.log("✅ Đã gửi file qua Telegram!");
    } catch (e) { console.error("❌ Lỗi Telegram File:", e.message); }
}

// --- HÀM CHẠY QUÉT DỮ LIỆU CHÍNH ---
async function runScraper() {
    console.log("🚀 Bắt đầu quá trình quét Dice.com...");
    let allJobs = [];

    for (const kw of KEYWORDS) {
        // Sử dụng địa điểm chính xác như bạn mong muốn
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Canada`;
        
        try {
            console.log(`🔍 Đang quét từ khóa: "${kw}"...`);
            const response = await axios.get('http://api.scraperapi.com', {
                params: {
                    api_key: process.env.SCRAPER_API_KEY,
                    url: targetUrl,
                    render: 'true',
                    premium: 'true',
                    country_code: 'ca',
                    wait: 25000, // Chờ 25 giây để trang tải hết (Rất quan trọng cho Dice)
                    keep_headers: 'true'
                },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                },
                timeout: 300000 
            });

            const $ = cheerio.load(response.data);
            let count = 0;

            // Bộ chọn dựa trên ID position bạn đã Inspect thấy trong hình
            $('a[id^="position-"]').each((i, el) => {
                const title = $(el).text().trim();
                if (!title) return;

                let link = $(el).attr('href');
                if (link && !link.startsWith('http')) {
                    link = `https://www.dice.com${link}`;
                }

                // Tìm vùng chứa thông tin bao quanh tiêu đề
                const card = $(el).closest('dhi-search-card, [class*="card"]');
                
                // Lấy công ty từ thuộc tính data-cy (xem trong hình image_153100.png)
                const company = card.find('[data-cy="search-result-company-name"]').text().trim() || 
                                card.find('.card-company').text().trim() || "N/A";

                // Lấy địa điểm
                const location = card.find('[data-cy="search-result-location"]').text().trim() || "Canada";

                // Lấy mức lương (bắt được cả dạng $50+ như trong hình image_0ac114.png)
                let salary = "N/A";
                card.find('span, div, dhi-badge').each((j, subEl) => {
                    const text = $(subEl).text().trim();
                    if (text.includes('$')) {
                        salary = text;
                        return false; 
                    }
                });

                allJobs.push({
                    "Title": title,
                    "Company": company,
                    "Location": location,
                    "Salary": salary,
                    "Link": link,
                    "Keyword": kw
                });
                count++;
            });

            console.log(`   ✅ Tìm thấy ${count} jobs cho "${kw}"`);

        } catch (error) {
            console.error(`   ❌ Lỗi khi quét ${kw}:`, error.message);
        }
    }

    // --- XỬ LÝ FILE VÀ GỬI BÁO CÁO ---
    if (allJobs.length > 0) {
        const fileName = `Dice_Jobs_Report.xlsx`;
        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Tổng cộng có ${allJobs.length} jobs.`);
        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ Dice.com Scraper hoàn tất! Tìm thấy <b>${allJobs.length}</b> jobs mới tại Canada.`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);
    } else {
        console.log("⚠️ Không tìm thấy job nào sau khi quét.");
        await sendTelegramAlert("⚠️ Dice.com Scraper hoàn thành nhưng không bắt được dữ liệu. Kiểm tra lại ScraperAPI Dashboard.");
    }
}

runScraper();