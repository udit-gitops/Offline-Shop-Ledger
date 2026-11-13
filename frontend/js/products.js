/* products.js — add, view, edit and delete products. */
(() => {
  const { money, esc } = App;
  const $ = (id) => document.getElementById(id);

  let products = [];
  let editingId = null; // id of the product open in the dialog, null when adding a new one

  async function load() {
    products = (await DB.getAll('products')).sort(App.byName);
    render();
  }

  function stockBadge(p) {
    if (p.quantity === 0) return '<span class="badge badge-danger">Out of stock</span>';
    if (p.quantity <= App.LOW_STOCK) return '<span class="badge badge-warn">Low stock</span>';
    return '<span class="badge badge-ok">In stock</span>';
  }

  function render() {
    const stockValue = products.reduce((sum, p) => sum + p.price * p.quantity, 0);
    $('summary').textContent = `${products.length} ${products.length === 1 ? 'product' : 'products'} · stock worth ${money(stockValue)}`;

    const term = $('search').value.trim().toLowerCase();
    const rows = products.filter((p) => p.name.toLowerCase().includes(term));

    if (!products.length) {
      $('tableBox').innerHTML = `<div class="empty"><strong>No products yet</strong>Add the items your shop sells to start billing.</div>`;
      return;
    }
    if (!rows.length) {
      $('tableBox').innerHTML = `<div class="empty">No product matches "${esc(term)}".</div>`;
      return;
    }

    $('tableBox').innerHTML = `<table>
      <thead><tr><th>Product</th><th class="num">Price</th><th class="num">Quantity</th><th>Stock</th><th>Sync</th><th></th></tr></thead>
      <tbody>${rows.map((p) => `
        <tr>
          <td>${esc(p.name)}</td>
          <td class="num">${money(p.price)}</td>
          <td class="num">${p.quantity}</td>
          <td>${stockBadge(p)}</td>
          <td>${App.syncBadge(p.syncStatus)}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="btn btn-sm" data-edit="${p.id}">Edit</button>
              <button type="button" class="btn btn-sm btn-danger" data-delete="${p.id}">Delete</button>
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function openDialog(product) {
    editingId = product ? product.id : null;
    $('dialogTitle').textContent = product ? 'Edit product' : 'Add product';
    $('pName').value = product ? product.name : '';
    $('pPrice').value = product ? product.price : '';
    $('pQty').value = product ? product.quantity : '';
    $('formError').hidden = true;
    $('productDialog').showModal();
    $('pName').focus();
  }

  App.onSubmit($('productForm'), $('formError'), async () => {
    // An empty box must be rejected, not silently treated as 0.
    if ($('pPrice').value === '' || $('pQty').value === '') throw new Error('Enter both price and quantity.');
    await DB.saveProduct({
      id: editingId,
      name: $('pName').value,
      price: Number($('pPrice').value),
      quantity: Number($('pQty').value),
    });
    $('productDialog').close();
    App.toast(editingId ? 'Product updated' : 'Product added');
    load();
  });

  $('tableBox').addEventListener('click', async (e) => {
    const editId = e.target.dataset.edit;
    const deleteId = e.target.dataset.delete;
    if (editId) openDialog(products.find((p) => p.id === editId));
    if (deleteId) {
      const product = products.find((p) => p.id === deleteId);
      if (!confirm(`Delete "${product.name}"?\nPast sales of this product will stay in your records.`)) return;
      await DB.deleteProduct(deleteId);
      App.toast('Product deleted');
      load();
    }
  });

  $('addBtn').addEventListener('click', () => openDialog(null));
  $('cancelBtn').addEventListener('click', () => $('productDialog').close());
  $('search').addEventListener('input', render);

  App.onSynced(load);
  load();
})();
