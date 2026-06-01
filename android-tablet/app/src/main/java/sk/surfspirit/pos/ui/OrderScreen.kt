package sk.surfspirit.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.net.*
import sk.surfspirit.pos.ui.components.PosHeader
import sk.surfspirit.pos.ui.theme.*

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
    var showPayDialog by remember { mutableStateOf(false) }
    var paying by remember { mutableStateOf(false) }
    var payError by remember { mutableStateOf<String?>(null) }
    var search by remember { mutableStateOf("") }
    val newItems = remember { mutableStateMapOf<Int, Int>() }

    val itemById = remember(categories) { categories.flatMap { it.items }.associateBy { it.id } }

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
                    val oid = if (cur == null) Api.service.createOrder(CreateOrderReq(tableId, payload)).id
                              else { Api.service.addItems(cur.id, AddItemsReq(payload)); cur.id }
                    Api.service.sendAndPrint(oid, SendReq(false))
                    oid
                }
                newItems.clear()
                current = withContext(Dispatchers.IO) { Api.service.tableOrders(tableId) }.firstOrNull { it.id == orderId }
            } catch (e: Exception) {
                error = "Odoslanie zlyhalo: ${e.message}"
            } finally { sending = false }
        }
    }

    fun pay(method: String) {
        val ord = current ?: return
        val amt = if (ord.totalAfterDiscount > 0.0) ord.totalAfterDiscount else ord.total
        if (amt <= 0.0 || paying) return
        paying = true; payError = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { Api.service.pay(PayReq(ord.id, method, amt)) }
                showPayDialog = false; onBack()
            } catch (e: Exception) {
                payError = "Platba zlyhala: ${e.message}"
            } finally { paying = false }
        }
    }

    val newTotal = newItems.entries.sumOf { (id, q) -> (itemById[id]?.price ?: 0.0) * q }
    val existingTotal = current?.total ?: 0.0
    val payAmount = current?.let { if (it.totalAfterDiscount > 0.0) it.totalAfterDiscount else it.total } ?: 0.0
    val canPay = current != null && newItems.isEmpty() && payAmount > 0.0 && !sending && !paying
    val sentQty = current?.items?.filter { it.sent }?.sumOf { it.qty } ?: 0

    Scaffold(
        topBar = {
            PosHeader(activeTab = "objednavka", userName = AppPrefs.userName,
                onStoly = onBack, onLogout = onBack, onRefresh = { reload() })
        }
    ) { pad ->
        if (loading) {
            Box(Modifier.fillMaxSize().padding(pad)) { CircularProgressIndicator(Modifier.align(Alignment.Center)) }
            return@Scaffold
        }
        Row(Modifier.fillMaxSize().padding(pad)) {

            // ── Ľavá: hľadanie + kategórie + menu ──
            Column(Modifier.weight(1.7f).padding(12.dp)) {
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    placeholder = { Text("Hľadať produkt alebo kategóriu…") },
                    leadingIcon = { Icon(Icons.Filled.Search, null) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    categories.forEachIndexed { i, c -> CatChip(c, i == selectedCat) { selectedCat = i } }
                }
                Spacer(Modifier.height(10.dp))
                val items = if (search.isBlank())
                    categories.getOrNull(selectedCat)?.items.orEmpty()
                else
                    categories.flatMap { it.items }.filter { it.name.contains(search, ignoreCase = true) }
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 132.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(items, key = { it.id }) { mi ->
                        ProductCard(mi) { newItems[mi.id] = (newItems[mi.id] ?: 0) + 1 }
                    }
                }
            }

            // ── Pravá: objednávka ──
            Surface(Modifier.weight(1f).fillMaxHeight(), color = MaterialTheme.colorScheme.surfaceVariant,
                tonalElevation = 1.dp) {
                Column(Modifier.fillMaxSize().padding(14.dp)) {
                    Text("Stôl #$tableId", style = MaterialTheme.typography.titleMedium)
                    current?.let {
                        Text(it.label, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (sentQty > 0) {
                        Text("$sentQty ks v kuchyni", style = MaterialTheme.typography.labelMedium,
                            color = Sage)
                    }
                    Spacer(Modifier.height(8.dp))
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        current?.items?.forEach { it2 ->
                            SentRow("${it2.emoji} ${it2.name}", it2.qty, it2.price * it2.qty)
                        }
                        newItems.entries.toList().forEach { (id, q) ->
                            val mi = itemById[id]
                            NewRow(
                                name = "${mi?.emoji ?: ""} ${mi?.name ?: "?"}",
                                qty = q,
                                lineTotal = (mi?.price ?: 0.0) * q,
                                onMinus = { if (q <= 1) newItems.remove(id) else newItems[id] = q - 1 },
                                onPlus = { newItems[id] = q + 1 },
                            )
                        }
                    }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("SPOLU", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        Text(money(existingTotal + newTotal), style = MaterialTheme.typography.titleLarge, color = Terra)
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }

                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick = { send() },
                        enabled = newItems.isNotEmpty() && !sending,
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                    ) {
                        if (sending) CircularProgressIndicator(Modifier.size(20.dp), color = Cream)
                        else Text("Poslať objednávku", style = MaterialTheme.typography.labelLarge)
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { payError = null; showPayDialog = true },
                        enabled = canPay,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                    ) { Text(if (payAmount > 0.0) "Zaplatiť ${money(payAmount)}" else "Zaplatiť") }
                    if (current != null && newItems.isNotEmpty()) {
                        Text("Najprv pošli nové položky, potom zaplať.",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    // Akčný riadok (web parita) — ostatné vrstvy doplníme neskôr
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("Predúčet", "Rozdeliť", "Zľava").forEach { lbl ->
                            OutlinedButton(onClick = { }, enabled = false,
                                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp),
                                modifier = Modifier.weight(1f)) {
                                Text(lbl, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                            }
                        }
                    }

                    if (showPayDialog) {
                        AlertDialog(
                            onDismissRequest = { if (!paying) showPayDialog = false },
                            title = { Text("Platba ${money(payAmount)}") },
                            text = {
                                Column {
                                    Text("Vyber spôsob platby:")
                                    payError?.let {
                                        Spacer(Modifier.height(8.dp))
                                        Text(it, color = MaterialTheme.colorScheme.error,
                                            style = MaterialTheme.typography.bodyMedium)
                                    }
                                    if (paying) { Spacer(Modifier.height(12.dp)); CircularProgressIndicator(Modifier.size(22.dp)) }
                                }
                            },
                            confirmButton = {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(onClick = { pay("hotovost") }, enabled = !paying,
                                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) { Text("Hotovosť") }
                                    Button(onClick = { pay("karta") }, enabled = !paying,
                                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) { Text("Karta") }
                                }
                            },
                            dismissButton = { TextButton(onClick = { showPayDialog = false }, enabled = !paying) { Text("Zrušiť") } },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CatChip(c: CategoryDto, active: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(10.dp),
        color = if (active) Terra.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp,
            if (active) Terra.copy(alpha = 0.40f) else MaterialTheme.colorScheme.outline),
    ) {
        Text(
            "${c.icon} ${c.label}",
            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            color = if (active) Terra else MaterialTheme.colorScheme.onSurface,
            fontWeight = if (active) FontWeight.ExtraBold else FontWeight.SemiBold,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
        )
    }
}

@Composable
private fun ProductCard(mi: MenuItemDto, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        tonalElevation = 1.dp,
        modifier = Modifier.height(96.dp),
    ) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Cream, CreamElev)))) {
            Column(Modifier.fillMaxSize().padding(10.dp)) {
                Surface(shape = RoundedCornerShape(8.dp), color = Terra.copy(alpha = 0.08f),
                    modifier = Modifier.size(34.dp)) {
                    Box(contentAlignment = Alignment.Center) { Text(mi.emoji, fontSize = 18.sp) }
                }
                Spacer(Modifier.weight(1f))
                Text(mi.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(money(mi.price), style = MaterialTheme.typography.labelLarge, color = Terra)
            }
        }
    }
}

@Composable
private fun SentRow(name: String, qty: Int, lineTotal: Double) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Check, "odoslané", Modifier.size(16.dp), tint = Sage)
        Spacer(Modifier.width(4.dp))
        Text("${qty}×", Modifier.width(30.dp), style = MaterialTheme.typography.labelMedium, color = Sage)
        Text(name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(money(lineTotal), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun NewRow(name: String, qty: Int, lineTotal: Double, onMinus: () -> Unit, onPlus: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        StepBtn("−", onMinus)
        Text("$qty", Modifier.width(26.dp), style = MaterialTheme.typography.labelMedium,
            color = Terra, fontWeight = FontWeight.Bold)
        StepBtn("+", onPlus)
        Spacer(Modifier.width(6.dp))
        Text(name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(money(lineTotal), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun StepBtn(label: String, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(7.dp),
        color = Terra.copy(alpha = 0.10f), modifier = Modifier.size(30.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, color = Terra, fontWeight = FontWeight.Bold, fontSize = 17.sp)
        }
    }
}
