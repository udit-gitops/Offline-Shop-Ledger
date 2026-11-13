/* reports.js — daily sales report and pending dues, calculated from local records. */
(() => {
  const { money, esc, round2 } = App;
  const $ = (id) => document.getElementById(id);
  const sum = (list, pick) => round2(list.reduce((total, x) => total + pick(x), 0));

  $('day').value = App.today();

  // Chart text uses the same font and grey as the rest of the page.
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = '#65726b';
  let weekChart = null;

  async function render() {
    $('day').max = App.today();
    const day = $('day').value || App.today();
    const [customers, sales, payments, saleItems, balances] = await Promise.all([
      DB.getAll('customers'), DB.getAll('sales'), DB.getAll('payments'), DB.getAll('saleItems'), DB.customerBalances(),
    ]);
    const dayLabel = App.fmtDate(day + 'T00:00:00');

    /* ----- Daily sales ----- */
    const daySales = sales.filter((s) => App.dayKey(s.createdAt) === day).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const dayPayments = payments.filter((p) => App.dayKey(p.createdAt) === day);
    const total = sum(daySales, (s) => s.totalAmount);
    const onCredit = sum(daySales, (s) => s.totalAmount - s.paidAmount);

    $('rCount').textContent = daySales.length;
    $('rDate').textContent = dayLabel;
    $('rTotal').textContent = money(total);
    $('rCredit').textContent = `${money(onCredit)} of it sold on credit`;
    $('rReceived').textContent = money(sum(dayPayments, (p) => p.amount));
    $('dayTitle').textContent = `Sales on ${dayLabel}`;

    $('dayBox').innerHTML = daySales.length
      ? `<table>
          <thead><tr><th>Time</th><th>Customer</th><th>Items</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Sync</th></tr></thead>
          <tbody>${daySales.map((s) => `
            <tr>
              <td class="muted">${App.fmtTime(s.createdAt)}</td>
              <td>${esc(App.customerName(customers, s.customerId))}</td>
              <td class="small">${esc(App.itemsText(saleItems, s.id))}</td>
              <td class="num">${money(s.totalAmount)}</td>
              <td class="num">${money(s.paidAmount)}</td>
              <td class="num">${money(s.totalAmount - s.paidAmount)}</td>
              <td>${App.syncBadge(s.syncStatus)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="3">Total</td><td class="num">${money(total)}</td><td class="num">${money(total - onCredit)}</td><td class="num">${money(onCredit)}</td><td></td></tr></tfoot>
        </table>`
      : `<div class="empty">No sales were recorded on this date.</div>`;

    /* ----- Pending dues ----- */
    const owing = customers
      .map((c) => ({ ...c, ...(balances[c.id] || { purchases: 0, paid: 0, balance: 0 }) }))
      .filter((c) => c.balance > 0)
      .sort((a, b) => b.balance - a.balance);
    const dues = sum(owing, (c) => c.balance);

    $('rDues').textContent = money(dues);
    $('rDuesNote').textContent = `${owing.length} ${owing.length === 1 ? 'customer' : 'customers'}`;
    $('rDuesCard').classList.toggle('is-warn', dues > 0);

    $('duesBox').innerHTML = owing.length
      ? `<table>
          <thead><tr><th>Customer</th><th class="num">Purchases</th><th class="num">Paid</th><th class="num">Pending</th></tr></thead>
          <tbody>${owing.map((c) => `
            <tr>
              <td><a href="customers.html?id=${c.id}">${esc(c.name)}</a></td>
              <td class="num">${money(c.purchases)}</td>
              <td class="num">${money(c.paid)}</td>
              <td class="num">${money(c.balance)}</td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="3">Total pending</td><td class="num">${money(dues)}</td></tr></tfoot>
        </table>`
      : `<div class="empty">No customer has pending dues.</div>`;

    /* ----- Last 7 days (oldest first) ----- */
    const week = [];
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      const list = sales.filter((s) => App.dayKey(s.createdAt) === App.dayKey(date));
      week.push({ date, count: list.length, total: sum(list, (s) => s.totalAmount) });
    }
    drawWeekChart(week);
    $('weekBox').innerHTML = `<table>
      <thead><tr><th>Date</th><th class="num">Sales</th><th class="num">Value</th></tr></thead>
      <tbody>${[...week].reverse().map((w) => `
        <tr>
          <td>${w.date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
          <td class="num">${w.count}</td>
          <td class="num">${money(w.total)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // Bar chart of the week's sales, drawn with Chart.js.
  // It is removed and drawn again each time, so it always shows current data.
  function drawWeekChart(week) {
    if (weekChart) weekChart.destroy();
    weekChart = new Chart($('weekChart'), {
      type: 'bar',
      data: {
        labels: week.map((w) => w.date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })),
        datasets: [{
          data: week.map((w) => w.total),
          backgroundColor: '#1a8a63',
          borderRadius: { topLeft: 4, topRight: 4 },
          maxBarThickness: 24,
        }],
      },
      options: {
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false }, // hovering anywhere above a day shows its numbers
        plugins: {
          legend: { display: false }, // one series only; the card title already names it
          tooltip: {
            displayColors: false,
            callbacks: {
              label: (item) => {
                const count = week[item.dataIndex].count;
                return `${money(item.parsed.y)} from ${count} ${count === 1 ? 'sale' : 'sales'}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            suggestedMax: 100,
            border: { display: false },
            grid: { color: '#ece8dc' },
            ticks: { maxTicksLimit: 5, callback: (value) => money(value) },
          },
        },
      },
    });
  }

  $('day').addEventListener('change', render);
  App.onSynced(render);
  render();
})();
