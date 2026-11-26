(function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var fmt = new Intl.NumberFormat("ru-RU");
  var compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
  var dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  var fullDayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

  function svg(name, attrs) {
    var el = document.createElementNS(NS, name);
    for (var key in attrs) el.setAttribute(key, attrs[key]);
    return el;
  }

  function parseDay(iso) {
    var p = iso.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  // Round the axis maximum up to 1, 2 or 5 times a power of ten.
  function niceMax(value) {
    if (value <= 0) return 1;
    var power = Math.pow(10, Math.floor(Math.log10(value)));
    var scaled = value / power;
    var step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * power;
  }

  function drawLine(figure) {
    var plot = figure.querySelector(".chart-plot");
    var source = figure.querySelector('script[type="application/json"]');
    if (!plot || !source) return;
    var data = JSON.parse(source.textContent);
    var unit = figure.dataset.unit || "";
    var title = figure.querySelector("figcaption").textContent;
    if (!data.length) return;

    var width = Math.max(plot.clientWidth, 260);
    var height = 190;
    var m = { top: 22, right: 18, bottom: 24, left: 44 };
    var innerW = width - m.left - m.right;
    var innerH = height - m.top - m.bottom;
    var top = niceMax(Math.max.apply(null, data.map(function (d) { return d.value; })));
    var tickFmt = top >= 10000 ? compact : fmt;

    function x(i) { return m.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW); }
    function y(v) { return m.top + innerH - (v / top) * innerH; }

    plot.textContent = "";
    var root = svg("svg", { viewBox: "0 0 " + width + " " + height, height: height, tabindex: "0", role: "img" });
    root.setAttribute("aria-label", title + ": " + data.length + " дн., последнее значение " + fmt.format(data[data.length - 1].value));

    [0, 0.5, 1].forEach(function (share) {
      var value = top * share;
      root.appendChild(svg("line", { x1: m.left, x2: width - m.right, y1: y(value), y2: y(value), class: share ? "grid" : "baseline" }));
      var label = svg("text", { x: m.left - 8, y: y(value) + 4, "text-anchor": "end", class: "tick" });
      label.textContent = tickFmt.format(value);
      root.appendChild(label);
    });

    var ticks = Math.min(5, data.length);
    for (var t = 0; t < ticks; t++) {
      var index = ticks === 1 ? 0 : Math.round((t / (ticks - 1)) * (data.length - 1));
      var anchor = t === 0 ? "start" : t === ticks - 1 ? "end" : "middle";
      var tick = svg("text", { x: x(index), y: height - 6, "text-anchor": anchor, class: "tick" });
      tick.textContent = dayFmt.format(parseDay(data[index].date));
      root.appendChild(tick);
    }

    var points = data.map(function (d, i) { return x(i) + "," + y(d.value); });
    root.appendChild(svg("path", {
      d: "M" + x(0) + "," + y(0) + " L" + points.join(" L") + " L" + x(data.length - 1) + "," + y(0) + " Z", class: "area"
    }));
    root.appendChild(svg("path", { d: "M" + points.join(" L"), class: "line" }));

    var last = data.length - 1;
    root.appendChild(svg("circle", { cx: x(last), cy: y(data[last].value), r: 4, class: "dot" }));
    var endLabel = svg("text", { x: x(last), y: Math.max(y(data[last].value) - 10, 12), "text-anchor": "end", class: "end-label" });
    endLabel.textContent = fmt.format(data[last].value);
    root.appendChild(endLabel);

    var cross = svg("line", { y1: m.top, y2: m.top + innerH, class: "cross", visibility: "hidden" });
    var marker = svg("circle", { r: 4, class: "dot", visibility: "hidden" });
    root.appendChild(cross);
    root.appendChild(marker);
    plot.appendChild(root);

    var tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    var tipValue = document.createElement("strong");
    var tipDate = document.createElement("span");
    tip.appendChild(tipValue);
    tip.appendChild(tipDate);
    plot.appendChild(tip);

    var active = -1;
    function show(i) {
      active = Math.max(0, Math.min(data.length - 1, i));
      var px = x(active), py = y(data[active].value);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      marker.setAttribute("cx", px); marker.setAttribute("cy", py); marker.setAttribute("visibility", "visible");
      tipValue.textContent = fmt.format(data[active].value) + (unit ? " " + unit : "");
      tipDate.textContent = fullDayFmt.format(parseDay(data[active].date));
      tip.hidden = false;
      var scale = plot.clientWidth / width;
      var half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(plot.clientWidth - half, px * scale)) + "px";
      tip.style.top = Math.max(py * scale - 10, tip.offsetHeight) + "px";
    }
    function hide() {
      active = -1;
      cross.setAttribute("visibility", "hidden");
      marker.setAttribute("visibility", "hidden");
      tip.hidden = true;
    }
    root.addEventListener("pointermove", function (event) {
      var box = root.getBoundingClientRect();
      var px = ((event.clientX - box.left) / box.width) * width;
      show(Math.round(((px - m.left) / innerW) * (data.length - 1)));
    });
    root.addEventListener("pointerleave", hide);
    root.addEventListener("blur", hide);
    root.addEventListener("focus", function () { show(data.length - 1); });
    root.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") { show(active - 1); event.preventDefault(); }
      if (event.key === "ArrowRight") { show(active + 1); event.preventDefault(); }
      if (event.key === "Escape") hide();
    });

    var holder = figure.querySelector(".chart-table");
    if (holder && !holder.firstChild) {
      var table = document.createElement("table");
      table.className = "data";
      var head = table.createTHead().insertRow();
      ["Дата", title].forEach(function (text, i) {
        var th = document.createElement("th");
        th.textContent = text;
        if (i) th.className = "n";
        head.appendChild(th);
      });
      var body = table.createTBody();
      data.slice().reverse().forEach(function (d) {
        var row = body.insertRow();
        row.insertCell().textContent = fullDayFmt.format(parseDay(d.date));
        var cell = row.insertCell();
        cell.className = "n";
        cell.textContent = fmt.format(d.value);
      });
      holder.appendChild(table);
    }
  }

  function drawAll() {
    document.querySelectorAll("figure.chart").forEach(drawLine);
  }

  document.querySelectorAll(".bars-fill").forEach(function (bar) {
    bar.style.width = Math.max(0, Math.min(100, Number(bar.dataset.share) || 0)) + "%";
  });

  drawAll();
  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawAll, 150);
  });

  // While a refresh runs, poll until it finishes and then show the new data.
  if (document.body.dataset.refreshing) {
    var note = document.getElementById("refresh-note");
    var poll = setInterval(function () {
      fetch(document.body.dataset.base + "/status", { credentials: "same-origin" })
        .then(function (response) { return response.json(); })
        .then(function (state) {
          if (!state.running) { clearInterval(poll); location.reload(); }
          else if (note) note.textContent = "Обновляется… " + state.step;
        })
        .catch(function () {});
    }, 4000);
  }
})();
