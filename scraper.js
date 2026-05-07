import { chromium } from 'playwright';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';

const KEYWORDS = ["Analyst"];

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
        throw new Error("Invalid link");
    } catch (error) {
        console.error("❌ Lỗi Catbox:", error.message);
        return "https://github.com";
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
    } catch (e) {}
}

// ====================== HÀM CHÍNH (DEBUG) ======================
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper - DEBUG MODE...");

    const browser = await chromium.launch({ headless: true });
    const keyword = "Analyst";

    try {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1920, height: 1080 });

        const url = `https://www.dice.com/jobs?q=${encodeURIComponent(keyword)}&countryCode=US&radius=30&radiusUnit=mi&language=en&page=1&pageSize=50`;
        console.log("🌐 Đang truy cập:", url);

        await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
        await page.waitForTimeout(15000);

        // Debug 1: Title trang
        const pageTitle = await page.title();
        console.log("📄 Page Title:", pageTitle);

        // Debug 2: Số lượng link job
        const linkCount = await page.evaluate(() => {
            return document.querySelectorAll('a[href*="/job-detail/"]').length;
        });
        console.log(`🔗 Tìm thấy ${linkCount} link job-detail`);

        // Debug 3: Lấy một phần HTML để xem cấu trúc
        const sampleHTML = await page.evaluate(() => {
            const bodyText = document.body.innerText.substring(0, 1500);
            return bodyText;
        });
        console.log("📋 Sample page content:", sampleHTML.substring(0, 800) + "...");

        // Debug 4: Kiểm tra có bị chặn không
        const isBlocked = await page.evaluate(() => {
            return document.body.innerText.includes("Access Denied") || 
                   document.body.innerText.includes("403") ||
                   document.body.innerText.includes("Robot") ||
                   document.body.innerText.length < 500;
        });
        console.log("🚫 Bị chặn?", isBlocked);

        await page.close();

    } catch (error) {
        console.log("❌ Lỗi chính:", error.message);
    }

    await browser.close();
    await sendTelegramAlert("🔍 Debug Dice.com đã chạy. Vui lòng xem log GitHub Actions.");
}

runScraper().catch(console.error);