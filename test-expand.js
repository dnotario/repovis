const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Listen to console logs
    page.on('console', msg => console.log('BROWSER:', msg.text()));
    
    await page.goto('http://localhost:3000');
    
    // Wait for content to load
    await page.waitForTimeout(2000);
    
    console.log('\n=== Clicking on a treemap node ===');
    
    // Find and click a treemap rect
    const rect = await page.locator('svg rect[data-name]').first();
    const name = await rect.getAttribute('data-name');
    console.log('Clicking on:', name);
    
    await rect.click();
    
    // Wait and observe
    await page.waitForTimeout(3000);
    
    console.log('\n=== Done ===');
    
    await browser.close();
})();
