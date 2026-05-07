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
        throw new Error("Không nhận được link hợp lệ từ Catbox: " + fileLink);
    } catch (error) {
        console.error("❌ Lỗi khi tải file lên Catbox:", error.message);
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
            {
                "type": "TextBlock",
                "text": "🚀 CẬP NHẬT CÔNG VIỆC MỚI TỪ DICE.COM",
                "weight": "Bolder",
                "size": "Medium",
                "color": "Accent"
            },
            {
                "type": "FactSet",
                "facts": [
                    { "title": "Nguồn dữ liệu:", "value": "Dice.com" },
                    { "title": "Khu vực quét:", "value": "Canada" },
                    { "title": "Tổng số lượng:", "value": `${totalJobs} công việc` },
                    { "title": "Trạng thái:", "value": "Hoàn tất thành công ✅" }
                ]
            }
        ],
        "actions": [
            {
                "type": "Action.OpenUrl",
                "title": "📥 TẢI FILE EXCEL KẾT QUẢ",
                "url": fileLink
            }
        ],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
    };

    try {
        await axios.post(webhookUrl, adaptiveCard);
        console.log("✅ Đã gửi thông báo tới Microsoft Teams thành công!");
    } catch (error) {
        console.error("❌ Lỗi khi gửi thông báo tới Teams:", error.message);
    }
}

// --- HÀM GỬI THÔNG BÁO TIN NHẮN TELEGRAM ---
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
        console.error("❌ Lỗi khi gửi tin nhắn Telegram:", error.message);
    }
}

// --- HÀM GỬI FILE EXCEL QUA TELEGRAM ---
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
        console.log("✅ Đã gửi file Excel qua Telegram thành công!");
    } catch (error) {
        console.error("❌ Lỗi khi gửi file qua Telegram:", error.message);
    }
}

// --- HÀM CHẠY QUÉT DỮ LIỆU CHÍNH ---
async function runScraper() {
    console.log("🚀 Bắt đầu quá trình quét Dice.com...");
    let allJobs = [];

    for (const keyword of KEYWORDS) {
        // Sử dụng location Canada để mở rộng kết quả tìm kiếm
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(keyword)}&location=Canada`;
        let attempts = 0;
        const maxAttempts = 2;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`🔍 Đang quét từ khóa: "${keyword}" (Lần thử ${attempts})...`);

                const response = await axios.get('http://api.scraperapi.com', {
                    params: {
                        api_key: process.env.SCRAPER_API_KEY,
                        url: targetUrl,
                        render: 'true',
                        premium: 'true',
                        country_code: 'ca',
                        wait: 20000, // Chờ 20 giây để trang render đầy đủ dữ liệu JavaScript
                        keep_headers: 'true'
                    },
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                    },
                    timeout: 200000 
                });

                const $ = cheerio.load(response.data);
                const pageTitle = $('title').text().trim();
                console.log(`   👉 Tiêu đề trang nhận được: "${pageTitle}"`);

                let countInPage = 0;

                // CHIẾN THUẬT QUÉT: Tìm tất cả các thẻ liên kết có ID bắt đầu bằng "position-"
                // Đây là cấu trúc ID duy nhất mà Dice đặt cho tiêu đề các công việc
                $('a[id^="position-"]').each((index, element) => {
                    const title = $(element).text().trim();
                    if (!title) return;

                    let link = $(element).attr('href');
                    if (link && !link.startsWith('http')) {
                        link = `https://www.dice.com${link}`;
                    }

                    // Tìm vùng chứa thông tin xung quanh tiêu đề để lấy công ty và địa điểm
                    const parentContainer = $(element).closest('dhi-search-card, [class*="card"], .search-card, div.ng-star-inserted');
                    
                    const company = parentContainer.find('[data-cy="search-result-company-name"], [class*="company"]').first().text().trim() || "Chưa cập nhật";
                    const location = parentContainer.find('[data-cy="search-result-location"], [class*="location"]').first().text().trim() || "Canada";
                    
                    // Tìm kiếm thông tin lương trong các thẻ phụ
                    let salary = "Thỏa thuận";
                    parentContainer.find('span, div, dhi-badge').each((i, subElement) => {
                        const text = $(subElement).text().trim();
                        if (text.includes('$') && text.length < 40) {
                            salary = text;
                            return false; // Thoát vòng lặp khi tìm thấy lương
                        }
                    });

                    allJobs.push({
                        "Tiêu đề": title,
                        "Công ty": company,
                        "Mức lương": salary,
                        "Địa điểm": location,
                        "Đường dẫn": link,
                        "Từ khóa": keyword
                    });
                    countInPage++;
                });

                console.log(`   ✅ Tìm thấy ${countInPage} công việc cho từ khóa "${keyword}"`);

                if (countInPage > 0) {
                    break; // Nếu có dữ liệu thì chuyển sang từ khóa tiếp theo
                } else {
                    // Nếu không thấy job, kiểm tra xem có bị chặn bởi tường lửa không
                    if (pageTitle.toLowerCase().includes('moment') || pageTitle.toLowerCase().includes('datadome')) {
                        console.log("   ⚠️ Phát hiện tường lửa DataDome, đang đợi để thử lại...");
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    } else {
                        console.log("   ℹ️ Trang tải xong nhưng không tìm thấy thẻ công việc phù hợp.");
                        break;
                    }
                }

            } catch (error) {
                console.error(`   ❌ Lỗi kết nối tại từ khóa ${keyword}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    // --- XỬ LÝ XUẤT FILE VÀ GỬI BÁO CÁO ---
    if (allJobs.length > 0) {
        const dateString = new Date().toISOString().slice(0, 10);
        const fileName = `Ket_qua_Dice_Canada_${dateString}.xlsx`;

        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Danh sach cong viec");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Tổng cộng thu thập được ${allJobs.length} công việc.`);
        console.log(`📊 Đã lưu vào file: ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        // Gửi đồng thời tới các nền tảng
        await Promise.all([
            sendTelegramAlert(`<b>[Dice.com]</b> Đã hoàn thành quét dữ liệu!\n🎯 Tổng cộng: <b>${allJobs.length}</b> công việc mới tại Canada.`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất toàn bộ quy trình!");
    } else {
        console.log("⚠️ Kết thúc quá trình: Không thu thập được dữ liệu nào.");
        await sendTelegramAlert("⚠️ <b>[Dice.com]</b> Quá trình quét đã chạy nhưng không tìm thấy công việc nào phù hợp trong hôm nay.");
    }
}

// Chạy hàm chính
runScraper();