import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- HÀM UPLOAD + NOTIFICATION (giữ nguyên) ---
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
    } catch (e) {
        console.error("❌ Telegram Alert Error:", e.message);
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
    } catch (e) {
        console.error("❌ Telegram File Error:", e.message);
    }
}

// --- HÀM CHẠY CHÍNH CHO DICE.COM ---
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper...");

    let allJobs = [];

    for (const kw of KEYWORDS) {
        // URL Dice.com (bạn có thể chỉnh location, radius, posted time...)
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&countryCode=US&radius=30&radiusUnit=mi&language=en&page=1&pageSize=100`;

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
                        // country_code: 'us' // Dice chủ yếu US
                    },
                    timeout: 60000
                });

                const $ = cheerio.load(response.data);
                let count = 0;

                // Selector chính cho job card trên Dice (cập nhật theo cấu trúc hiện tại)
                $('div[data-cy="search-card"], article, div[class*="job-card"]').each((i, el) => {
                    const titleEl = $(el).find('a[data-cy="card-title-link"], h3 a, h2 a');
                    const title = titleEl.text().trim();
                    if (!title) return;

                    const jobLink = titleEl.attr('href');
                    const fullLink = jobLink ? (jobLink.startsWith('http') ? jobLink : `https://www.dice.com${jobLink}`) : 'N/A';

                    const company = $(el).find('[data-cy="company-name"], .company-name, .employer').text().trim() || "N/A";
                    
                    const location = $(el).find('[data-cy="location"], .location, .job-location').text().trim() || "N/A";

                    // Salary
                    let salary = $(el).find('[data-cy="salary"], .salary, .compensation').text().trim();
                    salary = salary.replace(/\s+/g, ' ').trim();

                    const postedTime = $(el).find('time, [data-cy="posted-time"]').text().trim() || "";

                    const isEasyApply = $(el).find('button:contains("Easy Apply"), .easy-apply').length > 0;

                    allJobs.push({
                        Title: title,
                        Company: company,
                        Salary: salary || "",
                        Location: location,
                        'Posted': postedTime,
                        'Apply Method': isEasyApply ? "Easy Apply" : "Standard",
                        Link: fullLink,
                        Keyword: kw
                    });

                    count++;
                });

                console.log(`✅ Lấy được ${count} jobs cho từ khóa "${kw}"`);
                if (count > 0) break;

            } catch (err) {
                console.log(`⚠️ Lỗi ${kw} (lần ${attempts}): ${err.message}`);
                if (attempts < maxAttempts) {
                    await new Promise(r => setTimeout(r, 7000));
                }
            }
        }
    }

    if (allJobs.length > 0) {
        const fileName = `Dice_Jobs_Final.xlsx`; // hoặc thêm ngày: `Dice_Jobs_${new Date().toISOString().slice(0,10)}.xlsx`

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

        console.log("🏁 Hoàn tất!");
    } else {
        console.log("❌ Không tìm thấy job nào.");
        await sendTelegramAlert("❌ Không tìm thấy job mới nào trên Dice.");
    }
}

runScraper();