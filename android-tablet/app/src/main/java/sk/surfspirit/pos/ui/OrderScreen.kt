package sk.surfspirit.pos.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.net.*

private fun money(v: Double): String = String.format("%.2f €", v).replace('.', ',')

@Composable
fun OrderScreen(tableId: Int, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var categories by remember { mutableStateOf<List<CategoryDto>>(emptyList()) }
    var current by remember { mutableStateOf<OrderDto?>(null) }
    var selectedCat by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Lokálne nové (neodoslané) položky: menuItemId -> qty
    val newItems = remember { mutableStateMapOf<Int, Int>() }

    val itemById = remember(categories) {
        categories.flatMap { it.items }.associateBy { it.id }
    }

    fun reload() {
        scope.launch {
            try {
                val (menu, orders) = withContext(Dispatchers.IO) {
                    Api.service.menu() to Api.service.tableOrders(tableId)
                }
                categories = menu.filter { it.items.isNotEmpty() }
                current = orders.firstOrNull()
            } catch (e: Exception) {
                error = "Načítanie zlyhalo — skontroluj server."
            } finally { loading = false }
        }
    }
    LaunchedEffect(tableId) { reload() }

    fun send() {
        if (newItems.isEmpty() || sending) return
        sending = true; error = null
        scope.launch {
            try {
                val payload = newItems.map { (id, q) -> NewItem(menuItemId = id, qty = q) }
                val orderId = withContext(Dispatchers.IO) {
                    val cur = current
                    val oid = if (cur == null) {
                        Api.service.createOrder(CreateOrderReq(tableId, payload)).id
                    } else {
                        Api.service.addItems(cur.id, AddItemsReq(payload)); cur.id
                    }
                    Api.service.sendAndPrint(oid, SendReq(false))
                    oid
                }
                newItems.clear()
                // refresh order zo servera
                current = withContext(Dispatchers.IO) { Api.service.tableOrders(tableId) }.firstOrNull { it.id == orderId }
                    ?: withContext(Dispatchers.IO) { Api.service.tableOrders(tableId) }.firstOrNull()
            } catch (e: Exception) {
                error = "Odoslanie zlyhalo: ${e.message}"
            } finally { sending = false }
        }
    }

    val newTotal = newItems.entries.sumOf { (id, q) -> (itemById[id]?.price ?: 0.0) * q }
    val existingTotal = current?.total ?: 0.0

    Scaffold(
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Späť") }
                    Text("Stôl #$tableId", style = MaterialTheme.typography.titleMedium)
                    current?.let {
                        Spacer(Modifier.width(8.dp))
                        Text(it.label, style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    ) { pad ->
        if (loading) {
            Box(Modifier.fillMaxSize().padding(pad)) { CircularProgressIndicator(Modifier.align(Alignment.Center)) }
            return@Scaffold
        }
        Row(Modifier.fillMaxSize().padding(pad)) {

            // ── Ľavá: menu ──
            Column(Modifier.weight(1.7f).padding(12.dp)) {
                // Category chips
                Row(Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    categories.forEachIndexed { i, c ->
                        FilterChip(
                            selected = i == selectedCat,
                            onClick = { selectedCat = i },
                            label = { Text("${c.icon} ${c.label}") },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                val items = categories.getOrNull(selectedCat)?.items.orEmpty()
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 130.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(items, key = { it.id }) { mi ->
                        Surface(
                            onClick = { newItems[mi.id] = (newItems[mi.id] ?: 0) + 1 },
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.surface,
                            tonalElevation = 1.dp,
                            modifier = Modifier.height(86.dp),
                        ) {
                            Column(Modifier.fillMaxSize().padding(8.dp),
                                verticalArrangement = Arrangement.SpaceBetween) {
                                Text("${mi.emoji} ${mi.name}", style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(money(mi.price), style = MaterialTheme.typography.labelLarge,
                                    color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }

            // ── Pravá: objednávka ──
            Surface(Modifier.weight(1f).fillMaxHeight(), color = MaterialTheme.colorScheme.surfaceVariant) {
                Column(Modifier.fillMaxSize().padding(12.dp)) {
                    Text("Objednávka", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Column(
                        Modifier.weight(1f).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        // odoslané (zo servera)
                        current?.items?.forEach { it2 ->
                            OrderRow("${it2.emoji} ${it2.name}", it2.qty, it2.price * it2.qty, sent = true)
                        }
                        // nové lokálne (neodoslané)
                        newItems.entries.toList().forEach { (id, q) ->
                            val mi = itemById[id]
                            OrderRow("${mi?.emoji ?: ""} ${mi?.name ?: "?"}", q, (mi?.price ?: 0.0) * q, sent = false)
                        }
                    }
                    Divider(Modifier.padding(vertical = 8.dp))
                    Row { Text("Spolu", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        Text(money(existingTotal + newTotal), style = MaterialTheme.typography.titleMedium) }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium) }
                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick = { send() },
                        enabled = newItems.isNotEmpty() && !sending,
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                    ) {
                        if (sending) CircularProgressIndicator(Modifier.size(20.dp), color = MaterialTheme.colorScheme.onPrimary)
                        else Text("Poslať objednávku")
                    }
                    // Platba — ďalšia vrstva (fiškál cez server). Zatiaľ placeholder.
                    OutlinedButton(onClick = { }, enabled = false,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        Text("Platba (čoskoro)")
                    }
                }
            }
        }
    }
}

@Composable
private fun OrderRow(name: String, qty: Int, lineTotal: Double, sent: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("${qty}×", Modifier.width(34.dp), style = MaterialTheme.typography.labelLarge,
            color = if (sent) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary)
        Text(name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(money(lineTotal), style = MaterialTheme.typography.bodyMedium)
    }
}
