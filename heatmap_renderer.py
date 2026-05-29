
import asyncio
import base64
from pathlib import Path
from playwright.async_api import async_playwright

PAGE_URL = "https://sensor.bodyta.com/4096pdf/"

async def generate_heatmap_png(peak_arr, png_save_path: str) -> str:
    """把 4096 长度峰值帧数组渲染成 PNG，返回保存路径"""
    if len(peak_arr) != 4096:
        raise ValueError("峰值帧长度必须为 4096")
    png_save_path = Path(png_save_path)
    png_save_path.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
        await page.goto(PAGE_URL, wait_until="domcontentloaded")
        await page.wait_for_function("() => typeof window.bthClickHandle === 'function'")
        await page.wait_for_selector("#heatmapcanvas", state="attached")
        await page.evaluate("v => window.maxNum = v", 0.6)
        await page.evaluate("v => window.sizeNum = v", 14)
        await page.evaluate("(arr) => window.bthClickHandle(arr)", peak_arr)
        await page.wait_for_timeout(600)
        png_b64 = await page.evaluate(
            "() => document.getElementById('heatmapcanvas')"
            ".toDataURL('image/png').split(',')[1]"
        )
        png_save_path.write_bytes(base64.b64decode(png_b64))
        await browser.close()
    return str(png_save_path)