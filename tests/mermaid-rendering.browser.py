"""Browser regression for Mermaid's stylesheet and SVG image isolation.

Start Vite, then run with Python Playwright installed:
  python tests/mermaid-rendering.browser.py http://127.0.0.1:5173
Set CHROME_BIN to use an existing Chrome installation instead of Playwright's.
Only fixture API responses are used; no daemon or login is needed.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

base = sys.argv[1].rstrip("/")
output = Path(os.environ.get("MERMAID_TEST_OUTPUT", "/tmp/codex-mermaid-qa"))
output.mkdir(parents=True, exist_ok=True)
flow = """flowchart LR
 A[数据输入] --> B[预处理]
 B --> C[模型训练]
 C --> D[模型评估]
 D --> E[输出结果]
 B --> F[参数搜索]
 F --> C
 D --> B
 classDef green fill:#bbf7d0,stroke:#166534,color:#14532d;
 class A,E green;
"""
diagrams = [
    flow,
    "sequenceDiagram\n participant A as 用户\n participant B as 服务端\n A->>B: 提交请求\n B-->>A: 返回结果",
    "classDiagram\n Animal <|-- Duck\n Animal : +int age\n Duck : +quack()",
    "stateDiagram-v2\n [*] --> Ready\n Ready --> Working\n Working --> [*]",
]
messages = [{"id": str(i), "role": "assistant", "text": "```mermaid\n" + source.rstrip("\n") + "\n```"}
            for i, source in enumerate(diagrams)]
messages.append({"id": "invalid", "role": "assistant", "text": "```mermaid\nflowchart LR\n A[unfinished\n```"})
snapshot = {"title": "Mermaid regression", "cwd": "/project", "status": "idle",
            "messages": messages, "queued": [], "olderCursor": None, "expiresAt": None}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get("CHROME_BIN"),
                               args=["--no-sandbox", "--no-proxy-server", "--disable-dev-shm-usage"])
    context = browser.new_context(viewport={"width": 1280, "height": 900}, service_workers="block",
                                  permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    page.set_default_timeout(30000)
    page.add_init_script("localStorage.setItem('codexdesk.language','en')")
    errors, unexpected, external = [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: external.append(request.url) if "svg-test.invalid" in request.url else None)

    def api(route):
        if urlparse(route.request.url).path == "/api/shared/conversation":
            route.fulfill(json=snapshot)
        else:
            unexpected.append(route.request.url)
            route.fulfill(status=404, json={"error": "Unexpected fixture request"})

    page.route("**/api/**", api)
    # Fonts are not required for the regression; avoid relying on internet access.
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.goto(base + "/#share=11111111-1111-1111-1111-111111111111." + "a" * 43)
    images = page.get_by_role("img", name="Mermaid diagram", exact=True)
    expect(images).to_have_count(4)
    page.wait_for_function("""() => {
      const images = [...document.querySelectorAll('img[alt="Mermaid diagram"]')];
      return images.length === 4 && images.every(image => image.complete && image.naturalWidth > 0);
    }""")
    expect(page.locator(".markdown-diagram-error")).to_have_count(1)

    pixels = images.first.evaluate("""image => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let node = 0, green = 0, black = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i+3] < 250) continue;
        if (pixels[i] === 236 && pixels[i+1] === 236 && pixels[i+2] === 255) node++;
        if (pixels[i] === 187 && pixels[i+1] === 247 && pixels[i+2] === 208) green++;
        if (pixels[i] < 30 && pixels[i+1] < 30 && pixels[i+2] < 30) black++;
      }
      const xml = decodeURIComponent(image.src.split(',').slice(1).join(','));
      const svg = new DOMParser().parseFromString(xml, 'image/svg+xml');
      return {node, green, black, area: canvas.width * canvas.height,
        stylesheet: !!svg.querySelector('style'), labels: svg.documentElement.textContent,
        invalid: !!svg.querySelector('parsererror')};
    }""")
    assert pixels["node"] > 1000 and pixels["green"] > 1000, pixels
    assert pixels["black"] / pixels["area"] < 0.05, pixels
    assert pixels["stylesheet"] and not pixels["invalid"], pixels
    for label in ["数据输入", "预处理", "模型训练", "模型评估", "输出结果", "参数搜索"]:
        assert label in pixels["labels"], label
    expect(page.locator(".markdown-diagram style")).to_have_count(0)

    block = page.locator(".markdown-code-block").first
    block.get_by_role("button", name="Show code", exact=True).click()
    expect(block.locator("pre code")).to_have_text(flow.rstrip("\n"))
    block.get_by_role("button", name="Copy", exact=True).click()
    expect(block.get_by_role("button", name="Copied", exact=True)).to_be_visible()
    assert page.evaluate("navigator.clipboard.readText()") == flow.rstrip("\n")
    block.get_by_role("button", name="Hide code", exact=True).click()
    page.locator(".markdown-code-block").last.get_by_role("button", name="Show code", exact=True).click()
    expect(page.locator(".markdown-code-block").last.locator("pre code")).to_contain_text("A[unfinished")

    for theme in ["light", "dark"]:
        page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
        for width in [1280, 390, 320]:
            page.set_viewport_size({"width": width, "height": 900})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), (theme, width)
            assert images.evaluate_all("""images => images.every(image => {
              const rect = image.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.right <= innerWidth + 1 &&
                Math.abs(rect.width / rect.height - Number(image.getAttribute('width')) / Number(image.getAttribute('height'))) < 0.1;
            })"""), (theme, width)
            block.screenshot(path=str(output / f"flow-{theme}-{width}.png"))

    # Styles remain effective inside the image, but cannot affect the host page
    # or fetch external resources. Raw inline SVG keeps its stricter sanitizer.
    isolated = page.evaluate("""async () => {
      const {mermaidSvgImage, sanitizeSvg} = await import('/client/MarkdownCodeBlock.tsx');
      const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" onload="window.__svgExecuted=true">' +
        '<style>@import url(https://svg-test.invalid/import); body{display:none!important}' +
        'rect{fill:#bbf7d0} text{fill:url(https://svg-test.invalid/paint)}</style>' +
        '<script>window.__svgExecuted=true</script><foreignObject><div>unsafe</div></foreignObject>' +
        '<image href="https://svg-test.invalid/image"/><a href="javascript:alert(1)">link</a>' +
        '<rect width="40" height="20" onclick="window.__svgExecuted=true"/>' +
        '<text style="fill:url(https://svg-test.invalid/attr)">text</text></svg>';
      const preview = mermaidSvgImage(source);
      const xml = decodeURIComponent(preview.src.slice(preview.src.indexOf(',')+1));
      const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
      const image = document.createElement('img'); image.src = preview.src;
      document.body.append(image); await image.decode();
      const result = {width:preview.width, height:preview.height,
        active:!!doc.querySelector('script,foreignObject,image,a,[onload],[onclick]'),
        imported:!!window.__svgExecuted, display:getComputedStyle(document.body).display,
        inlineStyles:sanitizeSvg(source).includes('<style')};
      image.remove(); return result;
    }""")
    assert isolated == {"width": 40, "height": 20, "active": False, "imported": False,
                        "display": "block", "inlineStyles": False}, isolated
    assert not external and not unexpected and not errors, (external, unexpected, errors)
    print(json.dumps({"diagrams": len(diagrams), "default_fill_pixels": pixels["node"],
                      "custom_fill_pixels": pixels["green"], "black_area_ratio": pixels["black"] / pixels["area"],
                      "code_and_copy": "passed", "invalid_source": "passed", "svg_isolation": "passed",
                      "themes": ["light", "dark"], "widths": [1280, 390, 320], "screenshots": str(output)}))
    browser.close()
