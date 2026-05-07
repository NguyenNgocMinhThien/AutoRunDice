import axios from 'axios';
import XLSX from 'xlsx';
import * as cheerio from 'cheerio';
import fs from 'fs';
import FormData from 'form-data';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// --- HÀM UPLOAD LITTERBOX, TEAMS, TELEGRAM ---
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
                    { "title": "Khu vực:", "value": "Canada" },
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
        // Đổi location thành Canada để mở rộng phạm vi, đảm bảo có job trả về
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(kw)}&location=Canada`;
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
                        render: 'true',
                        premium: 'true',
                        country_code: 'ca' 
                    },
                    timeout: 120000 
                });

                const $ = cheerio.load(response.data);
                const pageTitle = $('title').text().trim();
                console.log(`   👉 Tiêu đề trang: "${pageTitle}"`);

                let count = 0;
                
                // MỞ RỘNG BỘ LỌC ĐỂ TÓM MỌI LOẠI GIAO DIỆN CỦA DICE
                let jobCards = $('dhi-search-card');
                if (jobCards.length === 0) {
                    // Nếu không có thẻ dhi-search-card, tìm tất cả các thẻ có class chứa chữ 'search-card' hoặc 'job-card'
                    jobCards = $('[class*="search-card"], [class*="job-card"], article.card');
                }

                jobCards.each((i, el) => {
                    const titleEl = $(el).find('a.card-title-link, a[data-cy="card-title-link"]');
                    const title = titleEl.text().trim();

                    if (!title) return;

                    let relativeLink = titleEl.attr('href');
                    let fullLink = relativeLink;
                    if (relativeLink && !relativeLink.startsWith('http')) {
                        fullLink = `https://www.dice.com${relativeLink}`;
                    }

                    const company = $(el).find('a[data-cy="search-result-company-name"]').text().trim() || 
                                    $(el).find('.card-company a').text().trim() || 
                                    "N/A";

                    const location = $(el).find('span[data-cy="search-result-location"]').text().trim() || 
                                     "N/A";

                    let salary = "N/A";
                    $(el).find('[class*="badge"], [class*="chip"], dhi-badge span, .badge').each((i, badgeEl) => {
                        let text = $(badgeEl).text().trim();
                        if (text.includes('$')) {
                            salary = text;
                            return false; 
                        }
                    });

                    if (salary === "N/A") {
                        $(el).find('span').each((i, spanEl) => {
                            let text = $(spanEl).text().trim();
                            if (text.includes('$') && text.length <= 20 && !text.includes('\n')) {
                                salary = text;
                                return false; 
                            }
                        });
                    }

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
                
                if (count > 0) {
                    break; // Có job -> Thoát vòng lặp
                } else {
                    const lowerTitle = pageTitle.toLowerCase();
                    if (lowerTitle.includes('just a moment') || lowerTitle.includes('datadome') || lowerTitle.includes('security')) {
                         console.log("   ⚠️ Bị DataDome chặn. Đang đợi thử lại...");
                         if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 15000));
                    } else {
                         // TRANG LOAD THÀNH CÔNG NHƯNG VẪN 0 JOBS
                         // Lưu lại giao diện trang HTML để bắt bệnh
                         const debugFileName = `debug_${kw.replace(/\s+/g, '_')}.html`;
                         fs.writeFileSync(debugFileName, response.data);
                         console.log("   ⏳ Đang upload file HTML thực tế để kiểm tra...");
                         const debugLink = await uploadToCatbox(debugFileName);
                         
                         console.log(`   🐛 BẤM VÀO LINK NÀY ĐỂ XEM MÀN HÌNH THỰC TẾ: ${debugLink}`);
                         console.log("   ℹ️ Có thể do trang load quá chậm hoặc không có job thật. Chuyển sang từ khóa tiếp theo.");
                         break;
                    }
                }

            } catch (err) {
                console.log(`   ⚠️ Lỗi (lần ${attempts}): ${err.message}`);
                if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 15000));
            }
        }
    }

    if (allJobs.length > 0) {
        const fileName = `Dice_Jobs_${new Date().toISOString().slice(0,10)}.xlsx`;

        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Đã lưu ${allJobs.length} jobs vào ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ [Dice.com] Tìm thấy ${allJobs.length} jobs mới tại Canada!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất!");
    } else {
        console.log("❌ Không tìm thấy job nào sau khi quét toàn bộ danh sách.");
        await sendTelegramAlert("❌ [Dice.com] Không tìm thấy job mới nào hôm nay.");
    }
}

runScraper();