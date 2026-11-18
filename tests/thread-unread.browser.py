"""Owner WebUI unread regression. Run against Vite with Python Playwright installed."""

import json
import os
import sys
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

base = sys.argv[1].rstrip("/")
root, child, other = [f"01a00000-0000-7000-8000-{n:012}" for n in range(1, 4)]
reply_a = {"turnId": "turn-a", "itemId": "reply-a"}
reply_b = {"turnId": "turn-b", "itemId": "reply-b"}
a = {"turnId": "turn-a", "item": {"id": "reply-a", "type": "agentMessage", "phase": "final_answer",
    "text": "First unread reply\n\n" + "\n\n".join(f"First reply paragraph {i}" for i in range(100))}}
b = {"turnId": "turn-b", "item": {"id": "reply-b", "type": "agentMessage", "phase": "final_answer",
    "text": "Second reply\n\n" + "\n\n".join(f"Second reply paragraph {i}" for i in range(70))}}


def thread(thread_id, name, parent=None):
    return {"id": thread_id, "name": name, "preview": name, "cwd": "/fixture", "projectId": "p1",
            "createdAt": 1, "updatedAt": 2, "recencyAt": 2, "status": {"type": "idle"},
            "canAcceptDirectInput": True, "parentThreadId": parent}


threads = {root: thread(root, "Parent fixture"), child: thread(child, "Child fixture", root),
           other: thread(other, "Read fixture")}
snapshot = {"revision": 0, "threads": {child: {"replies": [reply_a], "manual": None}}}
writes, reads, history_cursors, sockets, errors = [], [], [], [], []


def broadcast():
    snapshot["revision"] += 1
    for socket in sockets:
        socket.send(json.dumps({"method": "bridge/unreads/changed", "params": {}}))


def handle_api(route):
    path = urlparse(route.request.url).path
    if path == "/api/status":
        route.fulfill(json={"authenticated": True, "daemon": {"available": True}})
    elif path == "/api/thread-unreads":
        route.fulfill(json=snapshot)
    elif path.startswith("/api/thread-unreads/"):
        thread_id = path.rsplit("/", 1)[-1]
        mutation = route.request.post_data_json
        writes.append((thread_id, mutation))
        if mutation["action"] == "unread":
            snapshot["threads"][thread_id] = {"replies": [], "manual": {"token": "manual-mark", "reply": reply_b}}
        else:
            data = snapshot["threads"].get(thread_id, {"replies": [], "manual": None})
            # Deliver B before acknowledging A, as if it completed in another client.
            if thread_id == child and data["replies"] == [reply_a]:
                data["replies"].append(reply_b)
            data["replies"] = [reply for reply in data["replies"] if reply not in mutation["replies"]]
            if data["manual"] and data["manual"]["token"] == mutation.get("manualToken"):
                data["manual"] = None
            if not any(data.values()):
                snapshot["threads"].pop(thread_id, None)
        broadcast()
        route.fulfill(json=snapshot)
    elif path == "/api/goal-waits":
        route.fulfill(json={"waitingThreadIds": [child]})
    elif path == "/api/scheduled-tasks":
        route.fulfill(json=[])
    else:
        route.fulfill(json={"data": [], "tasks": [], "waitingThreadIds": [], "ready": False})


def handle_socket(socket):
    sockets.append(socket)
    socket.send(json.dumps({"method": "bridge/ready", "params": {}}))

    def receive(message):
        request = json.loads(message)
        method, params = request["method"], request.get("params", {})
        result = {"data": [], "nextCursor": None}
        if method == "thread/list":
            agents = "subAgent" in params.get("sourceKinds", [])
            result["data"] = [threads[child if agents else other]]
            result["nextCursor"] = None if agents else "more-roots"
        elif method == "thread/read":
            reads.append(params["threadId"])
            result["thread"] = threads[params["threadId"]]
        elif method == "project/list":
            result["data"] = [{"id": "p1", "name": "Fixture project", "roots": [{"path": "/fixture"}]}]
        elif method == "thread/resume":
            result = {"thread": threads[params["threadId"]], "cwd": "/fixture"}
        elif method == "thread/items/list":
            history_cursors.append(params.get("cursor"))
            result = {"data": [a], "nextCursor": None} if params.get("cursor") else {"data": [b], "nextCursor": "older-items"}
        elif method == "thread/goal/get":
            result = {"goal": None}
        elif method == "thread/queue/list":
            result = {"items": []}
        socket.send(json.dumps({"id": request["id"], "result": result}))

    socket.on_message(receive)


def open_web(context):
    page = context.new_page()
    page.set_default_timeout(10000)
    page.add_init_script("localStorage.setItem('codexdesk.language','en')")
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/**", handle_api)
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route_web_socket("**/api/rpc", handle_socket)
    page.goto(base)
    expect(page.get_by_label("Conversation list view")).to_have_value("projects")
    return page


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get("CHROME_BIN"),
                               args=["--no-sandbox", "--no-proxy-server", "--disable-dev-shm-usage"])
    desktop = open_web(browser.new_context(viewport={"width": 1280, "height": 850}, service_workers="block"))
    desktop.get_by_label("Conversation list view").select_option("read-state")
    unread = desktop.get_by_role("region", name="Unread", exact=True)
    read = desktop.get_by_role("region", name="Read", exact=True)
    expect(unread.get_by_text("Fixture project", exact=True)).to_be_visible()
    parent = unread.locator(".thread-row").filter(has_text="Parent fixture")
    agent = unread.locator(".thread-row").filter(has_text="Child fixture")
    expect(parent.locator(".thread-unread-dot")).to_have_count(0)
    expect(agent.locator(".thread-unread-dot")).to_be_visible()
    expect(agent.locator(".thread-status-waiting")).to_be_visible()
    expect(read.get_by_text("Read fixture", exact=True)).to_be_visible()
    assert root in reads
    parent.locator(".thread-tree-toggle").click()
    expect(parent.locator(".thread-unread-count")).to_have_text("1")
    expect(agent).to_have_count(0)
    parent.locator(".thread-tree-toggle").click()
    desktop.get_by_text("Only unread", exact=True).click()
    expect(read).to_have_count(0)
    desktop.get_by_text("Only unread", exact=True).click()

    mobile = open_web(browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True,
                                          is_mobile=True, service_workers="block"))
    mobile.get_by_role("button", name="Open history").click()
    mobile.get_by_label("Conversation list view").select_option("read-state")
    mobile_unread = mobile.get_by_role("region", name="Unread", exact=True)
    mobile_agent = mobile_unread.locator(".thread-row").filter(has_text="Child fixture")
    expect(mobile_agent.locator(".thread-unread-dot")).to_be_visible()

    desktop.bring_to_front()
    agent.locator(".thread-select").click()
    first = desktop.locator("[data-unread-reply]").filter(has_text="First unread reply")
    tail_a = first.locator("[data-unread-end]")
    expect(first.get_by_text("First unread reply", exact=True)).to_be_in_viewport()
    expect(tail_a).not_to_be_in_viewport()
    assert "older-items" in history_cursors and not writes
    desktop.evaluate("Object.defineProperty(document, 'hidden', {value:true, configurable:true})")
    tail_a.evaluate("element => element.scrollIntoView({block:'center'})")
    desktop.wait_for_timeout(250)
    assert not writes
    desktop.evaluate("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))")
    desktop.wait_for_function("!document.hidden && document.hasFocus()")
    expect(first.get_by_text("First reply paragraph 99", exact=True)).to_be_in_viewport()
    desktop.wait_for_timeout(450)
    assert writes == [(child, {"action": "read", "replies": [reply_a]})], writes
    assert snapshot["threads"][child]["replies"] == [reply_b]

    # The phone sees the same unread state and can clear it through long press.
    mobile.bring_to_front()
    expect(mobile_agent.locator(".thread-unread-dot")).to_be_visible()
    mobile_agent.locator(".thread-select").dispatch_event("pointerdown", {
        "pointerType": "touch", "pointerId": 1, "isPrimary": True, "button": 0, "clientX": 52, "clientY": 420,
    })
    mobile.get_by_role("menuitem", name="Mark as read", exact=True).click()
    expect(mobile_agent).to_have_count(0)
    desktop.bring_to_front()
    expect(agent).to_have_count(0)
    expect(read.get_by_text("Agent · Child fixture", exact=True)).to_be_visible()

    end_b = desktop.locator("[data-unread-reply]").filter(has_text="Second reply").locator("[data-unread-end]")
    end_b.evaluate("element => element.scrollIntoView({block:'center'})")
    read.locator(".thread-row").filter(has_text="Child fixture").locator(".thread-select").click(button="right")
    desktop.get_by_role("menuitem", name="Mark as unread", exact=True).click()
    expect(agent.locator(".thread-unread-dot")).to_be_visible()
    desktop.wait_for_timeout(250)
    assert snapshot["threads"][child]["manual"]["token"] == "manual-mark"
    assert not errors, errors
    if output := os.environ.get("UNREAD_QA_DIR"):
        desktop.screenshot(path=f"{output}/desktop.png")
        mobile.screenshot(path=f"{output}/mobile.png")
    print("Unread sidebar, first-unread pagination, foreground-only acknowledgement, stale reads and cross-device menus passed")
    browser.close()
