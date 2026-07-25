from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:4322"
initial_shot = Path("/tmp/youre-always-on-my-mind-initial.png")
cluster_shot = Path("/tmp/youre-always-on-my-mind-clusters.png")
timeline_shot = Path("/tmp/youre-always-on-my-mind-timeline.png")
timeline_mobile_shot = Path("/tmp/youre-always-on-my-mind-timeline-mobile.png")
cleanup_shot = Path("/tmp/youre-always-on-my-mind-cleanup.png")
alerts_shot = Path("/tmp/youre-always-on-my-mind-alerts.png")
sphere_detail_shot = Path("/tmp/youre-always-on-my-mind-sphere-detail.png")
sphere_detail_mobile_shot = Path("/tmp/youre-always-on-my-mind-sphere-detail-mobile.png")
desktop_shot = Path("/tmp/youre-always-on-my-mind-desktop.png")
mobile_shot = Path("/tmp/youre-always-on-my-mind-mobile.png")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1050}, device_scale_factor=1)
    errors = []
    failed_urls = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: failed_urls.append(f"{response.status} {response.url}") if response.status >= 400 else None)
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    try:
        page.wait_for_selector("#scene canvas", state="attached", timeout=8_000)
    except Exception:
        print("browser errors:", errors)
        print("failed resources:", failed_urls)
        print("app scripts:", page.locator('script[src]').evaluate_all("(nodes) => nodes.map((node) => node.src)"))
        raise
    assert page.locator("#scene canvas").is_visible()
    page.wait_for_function("window.__memoryMyceliumDebug?.length > 5")

    assert page.get_by_role("button", name="Volume").get_attribute("class") == "active"
    assert page.locator(".project-button").count() > 5
    assert page.locator(".signal-row").count() > 0
    assert int(page.locator("#semantic-count").inner_text()) > 0
    assert page.locator("#embedding-coverage").inner_text() != "Pendente"
    assert int(page.locator("#alert-nav-count").inner_text()) > 0
    assert "crítico" in page.locator("#alert-pill-label").inner_text().casefold()

    sizes = page.evaluate("window.__memoryMyceliumDebug")
    relations = page.evaluate("window.__memoryMyceliumDebugRelations")
    assert len(relations) == page.evaluate("window.__memoryMyceliumEdgeCount")
    assert len(relations) > 5
    assert all(relation["evidence"] for relation in relations)
    exposed_files = [file for relation in relations for file in relation["evidence"]["files"]]
    assert not any(
        ".env" in file
        or file.endswith("auth.json")
        or ".claude/" in file
        or ".codex/" in file
        or ".config/" in file
        for file in exposed_files
    )
    biggest = max(sizes, key=lambda node: node["observations"])
    smallest = min(sizes, key=lambda node: node["observations"])
    assert biggest["radius"] > smallest["radius"], (biggest, smallest)
    for left_index, left in enumerate(sizes):
        for right in sizes[left_index + 1:]:
            projected = (
                (left["position"]["x"] - right["position"]["x"]) ** 2
                + (left["position"]["y"] - right["position"]["y"]) ** 2
            ) ** 0.5
            assert projected > left["radius"] + right["radius"]
    base_positions = {node["project"]: node["position"] for node in sizes}
    layout = page.evaluate("window.__memoryMyceliumLayout")
    assert layout["method"] == "deterministic-anchor-registry-v1"
    assert layout["scope"] == "base"
    assert layout["persisted"] is True
    assert page.evaluate("Boolean(localStorage.getItem('youre-always-on-my-mind-layout-v1'))")
    page.get_by_role("button", name="Atividade").click()
    activity_positions = {
        node["project"]: node["position"]
        for node in page.evaluate("window.__memoryMyceliumDebug")
    }
    assert activity_positions == base_positions
    page.reload()
    page.wait_for_function("window.__memoryMyceliumDebug?.length > 5")
    reloaded_positions = {
        node["project"]: node["position"]
        for node in page.evaluate("window.__memoryMyceliumDebug")
    }
    assert reloaded_positions == base_positions
    assert page.evaluate("window.__memoryMyceliumLayout.reused") == len(base_positions)
    clusters = page.evaluate("window.__memoryMyceliumDebugClusters")
    assert set(clusters) == {"product", "client", "technology", "agent"}
    assert all(len(clusters[axis]) > 0 for axis in clusters)
    page.screenshot(path=str(initial_shot), full_page=False)

    total_projects = page.locator(".project-button").count()
    page.get_by_role("button", name="Clusters").click()
    assert page.locator("#cluster-toolbar").is_visible()
    assert page.locator("#cluster-color-key").inner_text() == "Cor = Produto"
    assert not page.locator(".agent-color-key").first.is_visible()
    product_positions = {
        node["project"]: node["position"]
        for node in page.evaluate("window.__memoryMyceliumDebug")
    }
    page.screenshot(path=str(cluster_shot), full_page=False)
    page.get_by_role("button", name="Tecnologia", exact=True).click()
    assert page.get_by_role("button", name="Tecnologia", exact=True).get_attribute("class") == "active"
    page.get_by_role("button", name="Produto", exact=True).click()
    restored_product_positions = {
        node["project"]: node["position"]
        for node in page.evaluate("window.__memoryMyceliumDebug")
    }
    assert restored_product_positions == product_positions
    page.get_by_role("button", name="Tecnologia", exact=True).click()
    cluster_choices = page.locator('.cluster-chip[data-cluster-id]:not([data-cluster-id=""])')
    assert cluster_choices.count() > 2
    cluster_choices.first.click()
    assert 0 < page.locator(".project-button").count() < total_projects
    page.get_by_role("button", name="Todos").click()
    assert page.locator(".project-button").count() == total_projects
    page.get_by_role("button", name="Volume").click()

    page.locator(".mode-switcher [data-action='alerts']").click()
    page.wait_for_selector(".alert-row")
    assert page.locator("#alerts-panel").is_visible()
    assert not page.locator("#graph-workspace").is_visible()
    initial_alert_total = int(page.locator("#alert-total").inner_text())
    assert initial_alert_total > 0
    assert int(page.locator("#alert-critical").inner_text()) > 0
    assert page.locator("#alert-stale-days").input_value() == "90"
    page.locator("#alert-stale-days").fill("365")
    page.locator("#alert-save").click()
    page.wait_for_function("document.querySelector('#alert-save-status').textContent.includes('salvas')")
    assert int(page.locator("#alert-total").inner_text()) < initial_alert_total
    page.locator("#alert-reset").click()
    page.wait_for_function("document.querySelector('#alert-save-status').textContent.includes('restaurados')")
    assert page.locator("#alert-stale-days").input_value() == "90"
    muted_project = page.locator(".alert-row").first.locator(".alert-row-main strong").inner_text()
    page.locator(".alert-row").first.get_by_role("button", name="Silenciar").click()
    page.wait_for_function("window.__memoryMyceliumAlerts?.muted === 1")
    assert muted_project in page.locator("#alert-muted-list").inner_text()
    page.locator("#alert-muted-list").get_by_role("button").click()
    page.wait_for_function("window.__memoryMyceliumAlerts?.muted === 0")
    page.screenshot(path=str(alerts_shot), full_page=True)
    page.get_by_role("button", name="Voltar à rede").click()
    assert page.locator("#graph-workspace").is_visible()

    page.get_by_role("button", name="Linha do tempo").click()
    page.wait_for_selector("#growth-chart svg")
    assert page.locator("#timeline-panel").is_visible()
    assert not page.locator("#graph-workspace").is_visible()
    assert page.locator("#growth-chart .timeline-hit").count() > 2
    assert page.locator("#saturation-chart svg").is_visible()
    assert page.locator("#agent-chart svg").is_visible()
    first_period = page.locator("#timeline-cursor-card").inner_text()
    page.locator("#growth-chart .timeline-hit").first.hover()
    assert page.locator("#timeline-cursor-card").inner_text() != first_period
    page.get_by_role("button", name="30 dias").click()
    page.wait_for_function("document.querySelectorAll('#growth-chart .timeline-hit').length >= 20")
    page.screenshot(path=str(timeline_shot), full_page=True)
    page.get_by_role("button", name="Voltar à rede").click()
    assert page.locator("#graph-workspace").is_visible()

    page.get_by_role("button", name="Limpeza segura").click()
    page.wait_for_selector(".candidate-row")
    assert page.locator("#cleanup-panel").is_visible()
    assert not page.locator("#graph-workspace").is_visible()
    assert int(page.locator("#cleanup-total").inner_text()) > 0
    first_candidate = page.locator(".candidate-row").first
    first_candidate.locator("input").check()
    page.get_by_role("button", name="Simular poda").click()
    page.get_by_role("button", name="Validar seleção").wait_for()
    assert page.locator(".prune-simulator").is_visible()
    assert "Redução imediata do arquivo" in page.locator(".prune-simulator").inner_text()
    assert "0 B" in page.locator(".prune-simulator").inner_text()
    assert "Potencial após compactar" in page.locator(".prune-simulator").inner_text()
    page.get_by_role("button", name="Validar seleção").click()
    page.get_by_role("button", name="Continuar para confirmação").wait_for()
    assert page.locator(".impact-metrics").is_visible()
    page.screenshot(path=str(cleanup_shot), full_page=True)
    page.get_by_role("button", name="Continuar para confirmação").click()
    assert page.locator("#cleanup-dialog").is_visible()
    phrase = page.locator("#cleanup-confirm-phrase").inner_text()
    page.locator("#cleanup-confirm-input").fill("EXCLUIR 999")
    assert page.locator("#execute-cleanup").is_disabled()
    page.locator("#cleanup-confirm-input").fill(phrase)
    assert page.locator("#execute-cleanup").is_enabled()
    page.get_by_role("button", name="Cancelar").click()
    page.get_by_role("button", name="Voltar à rede").click()
    assert page.locator("#graph-workspace").is_visible()

    first_project = page.locator(".project-button").first
    project_name = first_project.locator("strong").inner_text()
    first_project.click()
    assert project_name in page.locator("#detail-panel").inner_text()
    assert page.locator(".connection-card").count() > 0
    page.wait_for_selector(".memory-card")
    page.wait_for_function("window.__memoryMyceliumProjectMemory?.loading === false")
    initial_memory_count = page.locator(".memory-card").count()
    assert initial_memory_count > 0
    assert page.locator("#memory-inspector h3").is_visible()
    if page.locator("[data-memory-more]").count():
        page.locator("[data-memory-more]").click()
        page.wait_for_function(f"window.__memoryMyceliumProjectMemory?.returned > {initial_memory_count}")
    memory_title = page.locator(".memory-card").first.locator("strong").inner_text()
    search_term = next(word for word in memory_title.split() if len(word) >= 3)
    page.locator("[data-memory-search]").fill(search_term)
    page.wait_for_function(
        "(term) => window.__memoryMyceliumProjectMemory?.loading === false && window.__memoryMyceliumProjectMemory?.query === term",
        arg=search_term,
    )
    assert page.locator(".memory-card").count() > 0
    page.locator("[data-memory-search]").fill("credenciais para autenticação e acesso")
    page.locator("[data-memory-search-mode]").select_option("semantic")
    page.wait_for_function(
        "window.__memoryMyceliumProjectMemory?.loading === false && window.__memoryMyceliumProjectMemory?.searchMode === 'semantic'"
    )
    assert page.locator(".memory-semantic-pill").count() > 0
    assert "afinidade" in page.locator("#memory-sort-label").inner_text().casefold()
    page.locator(".memory-card").first.click()
    page.wait_for_selector("#memory-inspector h3")
    page.wait_for_selector(".quality-score")
    assert page.locator(".quality-metric").count() == 5
    assert "Risco ao excluir" in page.locator(".quality-panel").inner_text()
    assert "100 = perigoso apagar" in page.locator(".quality-panel").inner_text()
    page.screenshot(path=str(sphere_detail_shot), full_page=True)

    page.get_by_role("button", name="Relações").click()
    assert page.get_by_role("button", name="Relações").get_attribute("class") == "active"
    assert "conexões semânticas reais" in page.locator("#mode-kicker").inner_text().casefold()

    page.get_by_role("button", name="Saturação").click()
    assert "Organização por volume" not in page.locator("#mode-kicker").inner_text()
    assert page.get_by_role("button", name="Saturação").get_attribute("class") == "active"

    page.locator("#project-search").fill(project_name)
    assert page.locator(".project-button").count() == 1
    page.screenshot(path=str(desktop_shot), full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    mobile.goto(URL)
    mobile.wait_for_load_state("networkidle")
    mobile.wait_for_selector("#scene canvas")
    assert mobile.locator(".project-button").count() > 5
    mobile.locator(".project-button").first.click()
    mobile.wait_for_selector(".memory-card")
    assert mobile.locator("#memory-inspector").is_visible()
    mobile.wait_for_selector(".quality-score")
    mobile.screenshot(path=str(sphere_detail_mobile_shot), full_page=True)
    mobile.locator(".mode-switcher [data-action='alerts']").click()
    mobile.wait_for_selector(".alert-row")
    assert mobile.locator("#alerts-panel").is_visible()
    assert mobile.locator(".alert-rule").count() == 3
    mobile.get_by_role("button", name="Voltar à rede").click()
    mobile.get_by_role("button", name="Clusters").click()
    assert mobile.locator("#cluster-toolbar").is_visible()
    assert mobile.locator('.cluster-chip[data-cluster-id]:not([data-cluster-id=""])').count() > 2
    mobile.get_by_role("button", name="Linha do tempo").click()
    mobile.wait_for_selector("#growth-chart svg")
    assert mobile.locator("#timeline-panel").is_visible()
    mobile.screenshot(path=str(timeline_mobile_shot), full_page=True)
    mobile.get_by_role("button", name="Voltar à rede").click()
    mobile.get_by_role("button", name="Limpeza segura").click()
    mobile.wait_for_selector(".candidate-row")
    assert mobile.locator("#cleanup-panel").is_visible()
    mobile.locator(".candidate-row").first.locator("input").check()
    mobile.get_by_role("button", name="Simular poda").click()
    mobile.get_by_role("button", name="Validar seleção").wait_for()
    assert mobile.locator(".prune-simulator").is_visible()
    mobile.screenshot(path=str(mobile_shot), full_page=True)
    mobile.close()

    assert not errors, errors
    browser.close()

print(f"dashboard e2e passed: {initial_shot} {alerts_shot} {cluster_shot} {timeline_shot} {timeline_mobile_shot} {cleanup_shot} {sphere_detail_shot} {sphere_detail_mobile_shot} {desktop_shot} {mobile_shot}")
