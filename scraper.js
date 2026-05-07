import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- HÀM TẢI EXCEL LÊN LITTERBOX (CATBOX) ---
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

// --- HÀM GỬI THÔNG BÁO VÀO MICROSOFT TEAMS ---
async function sendToTeams(totalJobs, fileLink) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    const adaptiveCard = {
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": "🚀 CẬP NHẬT JOB MỚI TẠI DICE.COM", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            {
                "type": "FactSet",
                "facts": [
                    { "title": "Nguồn:", "value": "Dice.com" },
                    { "title": "Số lượng:", "value": `${totalJobs} jobs` },
                    { "title": "Trạng thái:", "value": "Đã sẵn sàng ✅" }
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

// --- HÀM GỬI THÔNG BÁO QUA TELEGRAM ---
async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId, 
            text: message, 
            parse_mode: 'HTML'
        });
    } catch (error) { 
        console.error("❌ Telegram Alert Error:", error.message); 
    }
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
    } catch (error) { 
        console.error("❌ Telegram File Error:", error.message); 
    }
}

// --- HÀM CHẠY CHÍNH ---
async function runScraper() {
    console.log("🚀 Khởi động Scraper cho Dice.com...");
    let allJobs = [];

    for (const kw of KEYWORDS) {
        // Địa điểm Burnaby, Canada theo yêu cầu của bạn
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Burnaby,%20BC,%20Canada`;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`🔍 Quét: ${kw} (Lần ${attempts})...`);

                const response = await axios.get('http://api.scraperapi.com', {
                    params: {
                        api_key: process.env.SCRAPER_API_KEY,
                        url: targetUrl,
                        render: 'true',           // DICE BẮT BUỘC CẦN RENDER ĐỂ HIỆN DỮ LIỆU
                        premium: 'true',          // DÙNG IP DÂN CƯ ĐỂ KHÔNG BỊ 403
                        country_code: 'ca',       // ƯU TIÊN IP CANADA
                        keep_headers: 'true'      // GIỮ HEADERS ĐỂ GIẢ LẬP NGƯỜI DÙNG THẬT
                    },
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                    },
                    timeout: 120000
                });

                const $ = cheerio.load(response.data);
                let count = 0;

                // Selector đặc thù của Dice cho các thẻ công việc
                $('a[id^="position-"]').each((i, el) => {
                    const title = $(el).text().trim();
                    if (!title) return;

                    const relativeLink = $(el).attr('href');
                    const card = $(el).closest('dhi-search-card');

                    // ==================== LẤY SALARY - SẠCH SẼ THEO LOGIC MẪU ====================
                    let salary = "";
                    let salaryEl = card.find('span, dhi-badge, div').filter(function() {
                        return $(this).text().includes('$');
                    }).first();

                    if (salaryEl.length) {
                        salary = salaryEl.text().trim();
                    }

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
                    // =============================================================================

                    const location = card.find('[data-cy="search-result-location"]').text().trim() || "Burnaby, BC";
                    const company = card.find('[data-cy="search-result-company-name"]').text().trim() || "N/A";

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

                console.log(`✅ Lấy được ${count} jobs cho từ khóa "${kw}"`);
                if (count > 0) break;

            } catch (error) {
                console.log(`⚠️ Lỗi ${kw} (lần ${attempts}): ${error.message}`);
                // NẾU LỖI 403: BÁO CÁO NGAY LẬP TỨC ĐỂ KIỂM TRA CREDITS
                if (error.response && error.response.status === 403) {
                    console.error("🛑 Lỗi 403 Forbidden: ScraperAPI bị chặn hoặc hết lượt dùng.");
                }
                if (attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    if (allJobs.length > 0) {
        const fileName = `Dice_Jobs_Burnaby.xlsx`;

        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Đã lưu ${allJobs.length} jobs vào ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ Dice.com: Tìm thấy ${allJobs.length} jobs mới!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất quá trình quét.");
    } else {
        console.log("❌ Không tìm thấy job nào trên Dice.com.");
        await sendTelegramAlert("❌ Dice.com: Không tìm thấy job mới nào.");
    }
}

runScraper();