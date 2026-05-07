import { Builder, By } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

async function debugDice() {
    console.log("🚀 Khởi động Chrome bằng Selenium...");
    
    // Cấu hình mở Chrome CÓ GIAO DIỆN (không dùng headless) để bạn nhìn bằng mắt
    let options = new chrome.Options();
    // Thêm cờ này để vượt qua một số check bot cơ bản của trình duyệt tự động
    options.addArguments('--disable-blink-features=AutomationControlled'); 

    let driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();

    try {
        const keyword = "Analyst";
        const targetUrl = `https://www.dice.com/jobs?q=${encodeURIComponent(keyword)}&location=Canada`;

        console.log(`🌍 Đang mở trang: ${targetUrl}`);
        await driver.get(targetUrl);

        console.log("👀 HÃY NHÌN VÀO CỬA SỔ CHROME VỪA BẬT LÊN!");
        console.log("⏳ Đang chờ 15 giây để xem web load xong hay bị chặn...");
        
        // Dừng 15 giây để bạn kịp nhìn màn hình
        await driver.sleep(15000);

        // Tool thử tự động tìm thẻ job giống như script cũ
        let jobCards = await driver.findElements(By.css('dhi-search-card, [class*="search-card"], article.card'));
        console.log(`🎯 Quét thử: Tìm thấy ${jobCards.length} job cards trên giao diện.`);

        if (jobCards.length === 0) {
            console.log("⚠️ Vẫn 0 jobs! Hãy xem trên màn hình Chrome lúc này đang hiển thị gì.");
        }

    } catch (error) {
        console.error("❌ Có lỗi xảy ra:", error);
    } finally {
        console.log("⏳ Giữ cửa sổ thêm 10 giây nữa rồi mới đóng...");
        await driver.sleep(10000);
        await driver.quit();
    }
}

debugDice();