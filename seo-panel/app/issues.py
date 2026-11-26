"""Turn cached data into a prioritised list of problems per site."""
from __future__ import annotations

SEVERITIES = ("critical", "serious", "warning")
SEVERITY_LABEL = {"critical": "Срочно", "serious": "Важно", "warning": "Желательно", "good": "Проблем не найдено"}

_YANDEX_SEVERITY = {"FATAL": "critical", "CRITICAL": "serious", "POSSIBLE_PROBLEM": "warning", "RECOMMENDATION": "warning"}

# Titles for the Webmaster diagnostics codes seen most often; an unknown code
# is shown as-is rather than guessed.
_YANDEX_TITLES = {
    "DISALLOWED_IN_ROBOTS": "Сайт закрыт от индексации в robots.txt",
    "DNS_ERROR": "Ошибка DNS — сайт не открывается",
    "CONNECT_FAILED": "Не удалось подключиться к серверу",
    "MAIN_PAGE_ERROR": "Главная страница отдаёт ошибку",
    "THREATS": "На сайте найдены угрозы безопасности",
    "SSL_CERTIFICATE_ERROR": "Проблема с SSL-сертификатом",
    "SLOW_AVG_RESPONSE_TIME": "Медленный ответ сервера",
    "NO_ROBOTS_TXT": "Нет файла robots.txt",
    "ERRORS_IN_ROBOTS_TXT": "Ошибки в robots.txt",
    "NO_SITEMAPS": "Не добавлен файл Sitemap",
    "ERRORS_IN_SITEMAPS": "Ошибки в файле Sitemap",
    "DOCUMENTS_MISSING_TITLE": "У страниц нет тега title",
    "DOCUMENTS_MISSING_DESCRIPTION": "У страниц нет мета-описания",
    "DUPLICATE_CONTENT_ATTRS": "Одинаковые title и description на разных страницах",
    "DUPLICATE_PAGES": "Найдены страницы-дубли",
    "SOFT_404": "Страницы отвечают 200 вместо 404",
    "MAIN_MIRROR_IS_NOT_HTTPS": "Главное зеркало не на HTTPS",
    "NO_METRIKA_COUNTER_CRAWL_ENABLED": "Не включён обход по счётчику Метрики",
    "NO_REGIONS": "Не задан регион сайта",
    "FAVICON_ERROR": "Проблема с favicon",
    "NOT_MOBILE_FRIENDLY": "Сайт не оптимизирован для мобильных",
}


def _issue(severity: str, source: str, title: str, detail: str = "") -> dict:
    return {"severity": severity, "source": source, "title": title, "detail": detail}


def audit_issues(audit: dict | None) -> list[dict]:
    if not audit:
        return []
    out: list[dict] = []
    home, robots, summary = audit["home"], audit["robots"], audit["summary"]
    source = "Проверка сайта"

    if home["error"]:
        out.append(_issue("critical", source, "Главная страница не открывается", home["error"]))
    elif home["status"] != 200:
        out.append(_issue("critical", source, f"Главная страница отвечает кодом {home['status']}"))
    elif home["noindex"]:
        out.append(_issue("critical", source, "На главной странице стоит noindex", home["robots_meta"]))

    blocked = [name for name, flag in (("Google", robots["blocks_google"]), ("Яндекс", robots["blocks_yandex"])) if flag]
    if blocked:
        out.append(_issue("critical", source, "robots.txt закрывает главную страницу", "Для: " + ", ".join(blocked)))
    if not robots["exists"]:
        out.append(_issue("warning", source, "Файл robots.txt не найден"))
    if home["status"] == 200 and home["canonical_mismatch"]:
        out.append(_issue("serious", source, "Canonical главной ведёт на другой адрес", home["canonical"]))

    if audit["sitemap"]["error"]:
        out.append(_issue("serious", source, "Sitemap не найден или пуст"))
    checked = summary["checked"]
    if checked:
        of = f"из {checked} проверенных адресов sitemap"
        counters = (
            ("noindex", "serious", "В sitemap есть страницы с noindex",
             "Уберите их из sitemap или снимите noindex."),
            ("blocked_google", "serious", "В sitemap есть страницы, закрытые в robots.txt для Google", ""),
            ("blocked_yandex", "serious", "В sitemap есть страницы, закрытые в robots.txt для Яндекса", ""),
            ("not_found", "serious", "В sitemap есть несуществующие страницы (404)", ""),
            ("server_error", "serious", "Страницы из sitemap не открываются", ""),
            ("redirect", "warning", "В sitemap есть адреса с редиректом",
             "В sitemap должны быть только конечные адреса."),
            ("canonical_mismatch", "warning", "У страниц из sitemap canonical указывает на другой адрес", ""),
        )
        for key, severity, title, advice in counters:
            if summary[key]:
                out.append(_issue(severity, source, title, f"{summary[key]} {of}. {advice}".strip()))
    return out


def gsc_issues(gsc: dict | None) -> list[dict]:
    if not gsc:
        return []
    out: list[dict] = []
    source = "Google Search Console"
    for item in gsc.get("inspections", []):
        if item.get("error"):
            continue
        if item.get("verdict") and item["verdict"] != "PASS":
            severity = "critical" if item.get("is_home") else "serious"
            out.append(_issue(severity, source, "Страница не в индексе Google",
                              f"{item['url']} — {item.get('coverageState') or item['verdict']}"))
    for sitemap in gsc.get("sitemaps", []):
        errors, warnings = int(sitemap.get("errors") or 0), int(sitemap.get("warnings") or 0)
        if errors:
            out.append(_issue("serious", source, "Ошибки в файле Sitemap", f"{sitemap.get('path')}: ошибок — {errors}"))
        elif warnings:
            out.append(_issue("warning", source, "Предупреждения в файле Sitemap",
                              f"{sitemap.get('path')}: предупреждений — {warnings}"))
    return out


def yandex_issues(ywm: dict | None) -> list[dict]:
    if not ywm:
        return []
    return [
        _issue(_YANDEX_SEVERITY.get(p.get("severity", ""), "warning"), "Яндекс Вебмастер",
               _YANDEX_TITLES.get(p["code"], p["code"]))
        for p in ywm.get("problems", [])
    ]


def site_issues(*, audit: dict | None, gsc: dict | None, ywm: dict | None) -> list[dict]:
    issues = audit_issues(audit) + gsc_issues(gsc) + yandex_issues(ywm)
    return sorted(issues, key=lambda i: SEVERITIES.index(i["severity"]))


def worst(issues: list[dict]) -> str:
    return issues[0]["severity"] if issues else "good"
