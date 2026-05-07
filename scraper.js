import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- 1. HÀM TẢI LÊN LITTERBOX (GIỮ NGUYÊN LOGIC CHẠY ĐƯỢC) ---
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
        throw new Error("Invalid link: " + fileLink);
    } catch (error) {
        console.error("❌ Lỗi Catbox:", error.message);
        return `https://github.com/${process.env.GITHUB_REPOSITORY}/actions`;
    }
}

// --- 2. HÀM GỬI TEAMS (THEO CHUẨN CARD LOGIC MỚI) ---
async function sendToTeams(totalJobs, fileLink) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    const adaptiveCard = {
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": "🚀 CẬP NHẬT JOB DICE - BURNABY & CANADA", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            {
                "type": "FactSet",
                "facts": [
                    { "title": "Nguồn:", "value": "Dice.com" },
                    { "title": "Số lượng:", "value": `${totalJobs} jobs` },
                    { "title": "Địa điểm:", "value": "Burnaby/Canada" }
                ]
            }
        ],
        "actions": [
            { "type": "Action.OpenUrl", "title": "📥 TẢI FILE EXCEL VỀ MÁY", "url": fileLink }
        ],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
    };

    try {
        await axios.post(webhookUrl, adaptiveCard);
        console.log("✅ [Teams] Đã gửi Card thành công!");
    } catch (error) {
        console.error("❌ [Teams] Lỗi gửi:", error.message);
    }
}

// --- 3. HÀM GỬI TELEGRAM (GIỮ NGUYÊN) ---
async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) { console.error("❌ Telegram Alert Error:", e.message); }
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
    } catch (e) { console.error("❌ Telegram File Error:", e.message); }
}

// --- 4. HÀM CHẠY CHÍNH (ÁP DỤNG CẤU TRÚC LOGIC THÀNH CÔNG) ---
async function runScraper() {
    console.log("🚀 Khởi động Dice Scraper...");
    let allJobs = [];

    for (const kw of KEYWORDS) {
        // Build URL theo đúng yêu cầu địa điểm Burnaby
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Burnaby,%20BC,%20Canada`;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`🔍 Quét Dice: ${kw} (Lần ${attempts})...`);

                const response = await axios.get('http://api.scraperapi.com', {
                    params: {
                        api_key: process.env.SCRAPER_API_KEY,
                        url: targetUrl,
                        render: 'true',
                        premium: 'true',
                        country_code: 'ca'
                    },
                    timeout: 90000
                });

                const $ = cheerio.load(response.data);
                let count = 0;

                // Sử dụng Selector mạnh nhất dựa trên ID 'position-' của Dice
                $('a[id^="position-"]').each((i, el) => {
                    const title = $(el).text().trim();
                    if (!title) return;

                    const relativeLink = $(el).attr('href');
                    const card = $(el).closest('dhi-search-card');

                    // ==================== LẤY SALARY - LOGIC SẠCH SẼ ====================
                    let salary = "";
                    // Dice thường để lương trong dhi-badge hoặc các span chứa ký tự $
                    card.find('span, dhi-badge, div').each((j, subEl) => {
                        const txt = $(subEl).text().trim();
                        if (txt.includes('$') && txt.length < 50) {
                            salary = txt;
                            return false;
                        }
                    });

                    // Làm sạch lương giống logic Indeed
                    salary = salary.replace(/\s+/g, ' ').trim();
                    if (salary.includes('$')) {
                        salary = salary
                            .replace(/Full-time/gi, '')
                            .replace(/Permanent/gi, '')
                            .replace(/Contract/gi, '')
                            .replace(/\+1/gi, '')
                            .trim();
                    } else {
                        salary = "N/A";
                    }
                    // =================================================================

                    const company = card.find('[data-cy="search-result-company-name"]').text().trim() || "N/A";
                    const location = card.find('[data-cy="search-result-location"]').text().trim() || "Burnaby, BC";

                    allJobs.push({
                        Title: title,
                        Company: company,
                        Salary: salary,
                        Location: location,
                        Link: relativeLink ? (relativeLink.startsWith('http') ? relativeLink : `https://www.dice.com${relativeLink}`) : 'N/A',
                        Keyword: kw
                    });

                    count++;
                });

                console.log(`✅ Lấy được ${count} jobs cho "${kw}"`);
                if (count > 0) break; 
                if (count === 0 && attempts === maxAttempts) console.log(`⚠️ Không tìm thấy job nào cho "${kw}" sau ${maxAttempts} lần thử.`);

            } catch (err) {
                console.log(`⚠️ Lỗi ${kw} (lần ${attempts}): ${err.message}`);
                if (err.response && err.response.status === 403) {
                    console.log("🛑 API bị 403. Kiểm tra lại Credits hoặc Gói ScraperAPI.");
                }
                if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    // --- KẾT THÚC VÀ XUẤT FILE ---
    if (allJobs.length > 0) {
        const fileName = `Dice_Jobs_Burnaby_${new Date().toISOString().slice(0,10)}.xlsx`;

        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Đã lưu ${allJobs.length} jobs vào ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ Dice: Tìm thấy ${allJobs.length} jobs mới tại Burnaby!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất!");
    } else {
        console.log("❌ Không tìm thấy bất kỳ job nào trên Dice.");
        await sendTelegramAlert("❌ Dice Scraper: Không tìm thấy job mới.");
    }
}

runScraper();