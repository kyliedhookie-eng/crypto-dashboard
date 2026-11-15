const API_BASE = "https://api.coingecko.com/api/v3";
const REFRESH_MS = 60000;
const CURRENCY_LOCALES = { usd: "en-US", eur: "en-IE", zar: "en-ZA" };

const API_KEY = ""; // optional: paste a free CoinGecko Demo key here (see Step 3)

async function fetchJson(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = API_KEY ? { "x-cg-demo-api-key": API_KEY } : {};
        const response = await fetch(url, { headers, signal: controller.signal });

        if (response.status === 429) {
            throw new Error("Rate limited (429). Wait a minute and try again.");
        }
        if (!response.ok) {
            throw new Error(`Server responded with status ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("The request timed out.");
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
// State: the current "situation" of the app
let coins = [];
let currency = localStorage.getItem("currency") ?? "usd";
let searchText = "";
let sortBy = "rank";
let favoritesOnly = false;
let favorites = loadFavorites();
let autoTimer = null;

// Chart popup state
let selectedCoin = null;
let selectedDays = 7;
let chart = null;
let chartRequestId = 0;

const grid = document.getElementById("coin-grid");
const statusBox = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const lastUpdated = document.getElementById("last-updated");
const autoToggle = document.getElementById("auto-refresh");
const searchInput = document.getElementById("search");
const currencySelect = document.getElementById("currency");
const sortSelect = document.getElementById("sort");
const favoritesBtn = document.getElementById("favorites-btn");

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalClose = document.getElementById("modal-close");
const rangeButtons = document.getElementById("range-buttons");
const chartStatus = document.getElementById("chart-status");
const chartCanvas = document.getElementById("price-chart");

function loadFavorites() {
    try {
        return JSON.parse(localStorage.getItem("favorites")) ?? [];
    } catch {
        return [];
    }
}

function toggleFavorite(id) {
    favorites = favorites.includes(id)
        ? favorites.filter(fav => fav !== id)
        : [...favorites, id];
    localStorage.setItem("favorites", JSON.stringify(favorites));
    render();
}

function saveCache() {
    localStorage.setItem(
        `cache-${currency}`,
        JSON.stringify({ time: Date.now(), coins })
    );
}

function loadCache() {
    try {
        return JSON.parse(localStorage.getItem(`cache-${currency}`));
    } catch {
        return null;
    }
}

function showLoading() {
    statusBox.className = "status loading";
    statusBox.textContent = "Loading live prices...";
    refreshBtn.disabled = true;
}

function showError(message) {
    statusBox.className = "status error";
    statusBox.textContent = message;
}

function showNotice(message) {
    statusBox.className = "status notice";
    statusBox.textContent = message;
}

function clearStatus() {
    statusBox.className = "status hidden";
    statusBox.textContent = "";
}

function formatPrice(number) {
    return number.toLocaleString(CURRENCY_LOCALES[currency], {
        style: "currency",
        currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
        maximumFractionDigits: number < 1 ? 6 : 2
    });
}

function createSparkline(prices, isUp) {
    if (!prices || prices.length === 0) return "";

    const width = 200;
    const height = 50;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    const points = prices.map((price, i) => {
        const x = (i / (prices.length - 1)) * width;
        const y = height - ((price - min) / range) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    return `
    <svg class="sparkline ${isUp ? "up" : "down"}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke-width="2" />
    </svg>`;
}

function createCard(coin) {
    const change = coin.price_change_percentage_24h ?? 0;
    const direction = change >= 0 ? "up" : "down";
    const arrow = change >= 0 ? "▲" : "▼";
    const isFav = favorites.includes(coin.id);

    const prices = coin.sparkline_in_7d?.price;
    const trendUp = prices ? prices[prices.length - 1] >= prices[0] : true;

    return `
    <article class="coin-card" data-id="${coin.id}">
      <button class="fav-btn ${isFav ? "active" : ""}" data-id="${coin.id}" aria-label="Toggle favorite">
        ${isFav ? "★" : "☆"}
      </button>
      <div class="coin-top">
        <img src="${coin.image}" alt="${coin.name} logo">
        <div>
          <h2>${coin.name}</h2>
          <span class="symbol">${coin.symbol.toUpperCase()}</span>
        </div>
      </div>
      <p class="price">${formatPrice(coin.current_price)}</p>
      <p class="change ${direction}">${arrow} ${Math.abs(change).toFixed(2)}% (24h)</p>
      ${createSparkline(prices, trendUp)}
    </article>
  `;
}

function getVisibleCoins() {
    const text = searchText.toLowerCase();

    const list = coins.filter(coin => {
        const matchesSearch =
            coin.name.toLowerCase().includes(text) ||
            coin.symbol.toLowerCase().includes(text);
        const matchesFavorites = !favoritesOnly || favorites.includes(coin.id);
        return matchesSearch && matchesFavorites;
    });

    if (sortBy === "price") {
        list.sort((a, b) => b.current_price - a.current_price);
    } else if (sortBy === "change") {
        list.sort((a, b) =>
            (b.price_change_percentage_24h ?? 0) - (a.price_change_percentage_24h ?? 0));
    } else {
        list.sort((a, b) => a.market_cap_rank - b.market_cap_rank);
    }

    return list;
}

function render() {
    const visible = getVisibleCoins();

    if (visible.length === 0) {
        const message = coins.length === 0
            ? "No data to show yet."
            : "No coins match your filters.";
        grid.innerHTML = `<p class="empty">${message}</p>`;
        return;
    }

    grid.innerHTML = visible.map(createCard).join("");
}

async function loadPrices() {
    showLoading();

    try {
        const url = `${API_BASE}/coins/markets?vs_currency=${currency}&order=market_cap_desc&per_page=20&page=1&sparkline=true`;
        coins = await fetchJson(url);
        saveCache();
        clearStatus();
        lastUpdated.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (error) {
        console.error(error);
        const cached = loadCache();

        if (cached) {
            coins = cached.coins;
            showNotice(
                `Live data unavailable. Showing saved prices from ${new Date(cached.time).toLocaleTimeString()}.`
            );
        } else {
            showError("Couldn't load prices. Check your connection and try again.");
        }
    } finally {
        refreshBtn.disabled = false;
        render();
    }
}

searchInput.addEventListener("input", (event) => {
    searchText = event.target.value.trim();
    render();
});

sortSelect.addEventListener("change", (event) => {
    sortBy = event.target.value;
    render();
});

currencySelect.addEventListener("change", (event) => {
    currency = event.target.value;
    localStorage.setItem("currency", currency);
    loadPrices();
});

favoritesBtn.addEventListener("click", () => {
    favoritesOnly = !favoritesOnly;
    favoritesBtn.classList.toggle("active", favoritesOnly);
    render();
});

refreshBtn.addEventListener("click", loadPrices);

function startAutoRefresh() {
    stopAutoRefresh();
    autoTimer = setInterval(loadPrices, REFRESH_MS);
}

function stopAutoRefresh() {
    clearInterval(autoTimer);
    autoTimer = null;
}

autoToggle.addEventListener("change", () => {
    autoToggle.checked ? startAutoRefresh() : stopAutoRefresh();
});

grid.addEventListener("click", (event) => {
    const star = event.target.closest(".fav-btn");
    const card = event.target.closest(".coin-card");

    if (star) {
        toggleFavorite(star.dataset.id);
    } else if (card) {
        openModal(card.dataset.id);
    }
});

function openModal(coinId) {
    selectedCoin = coins.find(coin => coin.id === coinId);
    if (!selectedCoin) return;

    selectedDays = 7;
    setActiveRange();
    modalTitle.innerHTML = `<img src="${selectedCoin.image}" alt=""> ${selectedCoin.name}`;
    modal.classList.remove("hidden");
    loadChart();
}

function closeModal() {
    chartRequestId++;
    modal.classList.add("hidden");
}

function setActiveRange() {
    rangeButtons.querySelectorAll("button").forEach(btn => {
        btn.classList.toggle("active", Number(btn.dataset.days) === selectedDays);
    });
}

async function loadChart() {
    const requestId = ++chartRequestId;
    chartStatus.textContent = "Loading chart...";

    try {
        const url = `${API_BASE}/coins/${selectedCoin.id}/market_chart?vs_currency=${currency}&days=${selectedDays}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Server responded with status ${response.status}`);
        }

        const data = await response.json();
        if (requestId !== chartRequestId) return;

        drawChart(data.prices);
        chartStatus.textContent = "";
    } catch (error) {
        if (requestId !== chartRequestId) return;
        console.error(error);
        chartStatus.textContent = "Couldn't load the chart. Try again in a minute.";
    }
}

function drawChart(prices) {
    const labels = prices.map(([time]) => {
        const date = new Date(time);
        return selectedDays === 1
            ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : date.toLocaleDateString([], { month: "short", day: "numeric" });
    });
    const values = prices.map(([, price]) => price);

    if (chart) chart.destroy();

    chart = new Chart(chartCanvas, {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: `${selectedCoin.name} (${currency.toUpperCase()})`,
                data: values,
                borderColor: "#d4af37",
                backgroundColor: "rgba(212, 175, 55, 0.1)",
                fill: true,
                pointRadius: 0,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: "#9a9a9a", maxTicksLimit: 6 }, grid: { display: false } },
                y: { ticks: { color: "#9a9a9a" }, grid: { color: "#222" } }
            }
        }
    });
}

rangeButtons.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    selectedDays = Number(btn.dataset.days);
    setActiveRange();
    loadChart();
});

modalClose.addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
});

currencySelect.value = currency;
loadPrices();

