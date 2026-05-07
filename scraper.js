import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// ====================== HÀM HỖ TRỢ ======================
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
            { 
                "type": "TextBlock", 
                "text": "🚀 CẬP NHẬT JOB MỚI TẠI DICE.COM", 
                "weight": "Bolder", 
                "size": "Medium", 
                "color": "Accent" 
            },
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
            { 
                "type": "Action.OpenUrl", 
                "title": "📥 TẢI FILE EXCEL VỀ MÁY", 
                "url": fileLink 
            }
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

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper...");

    let allJobs = [];

    const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0"
    ];

    for (const keyword of KEYWORDS) {
        let attempts = 0;
        const maxAttempts = 4;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`🔍 Quét từ khóa: ${keyword} (Lần ${attempts})...`);

                const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(keyword)}&countryCode=US&radius=30&radiusUnit=mi&language=en&page=1&pageSize=50`;

                const response = await axios.get('http://api.scraperapi.com', {
                    params: {
                        api_key: process.env.SCRAPER_API_KEY,
                        url: targetUrl,
                        render: 'true',
                        keep_headers: 'true'
                    },
                    headers: {
                        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': 'https://www.dice.com/'
                    },
                    timeout: 90000
                });

                const $ = cheerio.load(response.data);
                let count = 0;

                // Lấy các thẻ chứa job
                $('div[data-cy="search-card"], article, div[class*="JobCard"]').each((index, element) => {
                    const titleElement = $(element).find('a[data-cy="card-title-link"], h3 a, h2 a').first();
                    const title = titleElement.text().trim();

                    if (!title) return;

                    let jobLink = titleElement.attr('href');
                    const fullLink = jobLink && jobLink.startsWith('http') 
                        ? jobLink 
                        : `https://www.dice.com${jobLink}`;

                    const company = $(element).find('[data-cy="company-name"], .company-name, .employer').text().trim() || "N/A";
                    const location = $(element).find('[data-cy="location"], .location').text().trim() || "N/A";
                    const salary = $(element).find('[data-cy="salary"], .salary, .compensation').text().trim() || "";
                    const postedTime = $(element).find('time').text().trim() || "";

                    allJobs.push({
                        Title: title,
                        Company: company,
                        Salary: salary,
                        Location: location,
                        Posted: postedTime,
                        Link: fullLink,
                        Keyword: keyword
                    });

                    count++;
                });

                console.log(`✅ Lấy được ${count} jobs cho từ khóa "${keyword}"`);

                if (count > 3) {
                    break; // Thành công thì không thử lại
                }

            } catch (error) {
                console.log(`❌ Lỗi ${keyword} (Lần ${attempts}): ${error.message}`);

                if (error.response && error.response.status === 403) {
                    console.log("🔄 Bị chặn 403 - Đang chờ lâu hơn...");
                    await new Promise(resolve => setTimeout(resolve, 12000 + attempts * 6000));
                } else {
                    await new Promise(resolve => setTimeout(resolve, 8000));
                }
            }
        }
    }

    // ====================== LƯU FILE VÀ GỬI THÔNG BÁO ======================
    if (allJobs.length > 0) {
        const fileName = "Dice_Jobs_Final.xlsx";

        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Đã lưu ${allJobs.length} jobs vào file ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ Dice.com: Tìm thấy ${allJobs.length} jobs mới!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất scraper Dice.com!");
    } else {
        console.log("❌ Không tìm thấy job nào.");
        await sendTelegramAlert("❌ Không tìm thấy job mới nào trên Dice.com.");
    }
}

runScraper();