import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- HÀM UPLOAD LITTERBOX, TEAMS, TELEGRAM giữ nguyên ---
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
            { "type": "TextBlock", "text": "🚀 CẬP NHẬT JOB MỚI TỪ DICE.COM", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            {
                "type": "FactSet",
                "facts": [
                    { "title": "Nguồn:", "value": "Dice.com" },
                    { "title": "Khu vực:", "value": "Vancouver, BC" },
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

// --- HÀM CHẠY CHÍNH DÀNH CHO DICE.COM ---
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper...");
    let allJobs = [];

    for (const kw of KEYWORDS) {
        // Cấu trúc URL tìm kiếm của Dice.com
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Vancouver,%20BC`;
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
                        render: 'true', // BẮT BUỘC để render React/Angular trên Dice
                        country_code: 'ca' 
                    },
                    timeout: 120000 // Tăng timeout lên 2 phút vì render JS tốn thời gian
                });

                const $ = cheerio.load(response.data);
                let count = 0;

                // Cấu trúc HTML của Dice thường sử dụng thẻ dhi-search-card
                $('dhi-search-card').each((i, el) => {
                    const titleEl = $(el).find('a.card-title-link');
                    const title = titleEl.text().trim();

                    if (!title) return;

                    let relativeLink = titleEl.attr('href');
                    let fullLink = relativeLink;
                    // Đảm bảo link là URL tuyệt đối
                    if (relativeLink && !relativeLink.startsWith('http')) {
                        fullLink = `https://www.dice.com${relativeLink}`;
                    }

                    const company = $(el).find('a[data-cy="search-result-company-name"]').text().trim() || 
                                    $(el).find('.card-company a').text().trim() || 
                                    "N/A";

                    const location = $(el).find('span[data-cy="search-result-location"]').text().trim() || 
                                     "Vancouver, BC";

                    // Dice rất hiếm khi hiển thị lương ngoài trang tìm kiếm, cố gắng quét nếu có
                    let salary = $(el).find('span[data-cy="search-card-salary"]').text().trim() || "N/A";

                    const isRemote = $(el).text().toLowerCase().includes('remote');
                    const applyMethod = isRemote ? "Remote/Online" : "Standard Apply";

                    allJobs.push({
                        Title: title,
                        Company: company,
                        Salary: salary,
                        Location: location,
                        'Apply Method': applyMethod,
                        Link: fullLink || 'N/A',
                        Keyword: kw
                    });

                    count++;
                });

                console.log(`✅ Lấy được ${count} jobs cho từ khóa "${kw}"`);
                if (count > 0) break; // Thoát vòng lặp retry nếu lấy được dữ liệu thành công

            } catch (err) {
                console.log(`⚠️ Lỗi ${kw} (lần ${attempts}): ${err.message}`);
                if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 10000)); // Nghỉ 10s trước khi thử lại
            }
        }
    }

    if (allJobs.length > 0) {
        // Đổi tên file output cho phù hợp
        const fileName = `Dice_Jobs_${new Date().toISOString().slice(0,10)}.xlsx`;

        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Đã lưu ${allJobs.length} jobs vào ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ [Dice.com] Tìm thấy ${allJobs.length} jobs mới tại Vancouver!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất!");
    } else {
        console.log("❌ Không tìm thấy job nào.");
        await sendTelegramAlert("❌ [Dice.com] Không tìm thấy job mới nào hôm nay.");
    }
}

runScraper();