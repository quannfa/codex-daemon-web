"""Browser regression for the open-source Mermaid viewer integration.

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
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.goto(base + "/#share=11111111-1111-1111-1111-111111111111." + "a" * 43)
    page.wait_for_function("""() =>
      document.querySelectorAll('.react-mermaid-wrapper svg[id^="codex-mermaid-"]').length === 4
    """)

    wrappers = page.locator(".react-mermaid-wrapper")
    valid = wrappers.locator("svg[id^='codex-mermaid-']")
    expect(wrappers).to_have_count(5)
    expect(valid).to_have_count(4)
    expect(page.locator(".react-mermaid-error")).to_have_count(1)

    layout = wrappers.evaluate_all("""wrappers => wrappers.slice(0, 4).map(wrapper => {
      const svg = wrapper.querySelector('svg[id^="codex-mermaid-"]');
      const wrapperBox = wrapper.getBoundingClientRect();
      const svgBox = svg.getBoundingClientRect();
      const shapes = [...svg.querySelectorAll('.node rect,.node circle,.node ellipse,.node polygon,.node path')];
      const fills = shapes.map(shape => getComputedStyle(shape).fill);
      return {
        wrapperWidth: wrapperBox.width, wrapperHeight: wrapperBox.height,
        svgWidth: svgBox.width, svgHeight: svgBox.height,
        svgInside: svgBox.left >= wrapperBox.left - 1 && svgBox.right <= wrapperBox.right + 1 &&
          svgBox.top >= wrapperBox.top - 1 && svgBox.bottom <= wrapperBox.bottom + 1,
        stylesheet: !!svg.querySelector('style'),
        defaultFill: fills.filter(fill => fill === 'rgb(236, 236, 255)').length,
        customFill: fills.filter(fill => fill === 'rgb(187, 247, 208)').length,
      };
    })""")
    assert all(item["wrapperWidth"] > 0 and item["wrapperHeight"] > 0 and item["svgWidth"] > 0 and
               item["svgHeight"] > 0 and item["svgInside"] and item["stylesheet"] for item in layout), layout
    assert layout[0]["defaultFill"] > 0 and layout[0]["customFill"] > 0, layout[0]

    first = wrappers.first
    expect(first.get_by_role("button", name="Fullscreen", exact=True)).to_be_visible()
    expect(first.get_by_role("button", name="Zoom in", exact=True)).to_be_visible()
    expect(first.get_by_role("button", name="Reset view", exact=True)).to_be_visible()
    transform_before = first.locator("[style*='transform']").get_attribute("style")
    first.get_by_role("button", name="Zoom in", exact=True).click()
    page.wait_for_timeout(250)
    transform_after = first.locator("[style*='transform']").get_attribute("style")
    assert transform_after != transform_before, (transform_before, transform_after)
    first.get_by_role("button", name="Reset view", exact=True).click()
    first.get_by_role("button", name="Fullscreen", exact=True).click()
    assert "react-mermaid-fullscreen" in (first.get_attribute("class") or "")
    first.get_by_role("button", name="Exit fullscreen", exact=True).click()

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
            page.wait_for_timeout(350)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), (theme, width)
            assert valid.evaluate_all("""svgs => svgs.every(svg => {
              const svgBox = svg.getBoundingClientRect();
              const wrapperBox = svg.closest('.react-mermaid-wrapper').getBoundingClientRect();
              return svgBox.width > 0 && svgBox.height > 0 &&
                svgBox.left >= wrapperBox.left - 1 && svgBox.right <= wrapperBox.right + 1 &&
                svgBox.top >= wrapperBox.top - 1 && svgBox.bottom <= wrapperBox.bottom + 1;
            })"""), (theme, width)
            block.screenshot(path=str(output / f"flow-{theme}-{width}.png"))

    # Raw inline SVG keeps its stricter sanitizer and cannot execute active content.
    sanitized = page.evaluate("""async () => {
      const {sanitizeSvg} = await import('/client/MarkdownCodeBlock.tsx');
      const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" onload="window.__svgExecuted=true">' +
        '<style>body{display:none!important}</style><script>window.__svgExecuted=true</script>' +
        '<foreignObject><div>unsafe</div></foreignObject><image href="https://svg-test.invalid/image"/>' +
        '<a href="javascript:alert(1)">link</a><rect width="40" height="20" onclick="window.__svgExecuted=true"/></svg>';
      const cleaned = sanitizeSvg(source);
      const doc = new DOMParser().parseFromString(cleaned, 'image/svg+xml');
      return {active:!!doc.querySelector('script,foreignObject,image,a,[onload],[onclick]'),
        imported:!!window.__svgExecuted, display:getComputedStyle(document.body).display,
        inlineStyles:cleaned.includes('<style')};
    }""")
    assert sanitized == {"active": False, "imported": False, "display": "block", "inlineStyles": False}, sanitized
    assert not external and not unexpected and not errors, (external, unexpected, errors)
    print(json.dumps({"diagrams": len(diagrams), "stylesheets_preserved": True,
                      "auto_fit_and_bounds": "passed", "zoom_pan_fullscreen": "passed",
                      "code_and_copy": "passed", "invalid_source": "passed",
                      "svg_sanitizer": "passed", "themes": ["light", "dark"],
                      "widths": [1280, 390, 320], "screenshots": str(output)}))
    browser.close()
