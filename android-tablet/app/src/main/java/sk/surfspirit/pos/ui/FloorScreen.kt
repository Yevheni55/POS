package sk.surfspirit.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.TableDto
import sk.surfspirit.pos.ui.components.PosHeader
import sk.surfspirit.pos.ui.components.ShiftStrip
import sk.surfspirit.pos.ui.components.statusColor
import sk.surfspirit.pos.ui.components.statusGlyph
import sk.surfspirit.pos.ui.components.statusLabel
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.CreamElev
import sk.surfspirit.pos.ui.theme.CreamSunken

@Composable
fun FloorScreen(onOpenTable: (Int) -> Unit, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    var tables by remember { mutableStateOf<List<TableDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    fun load() {
        loading = true; error = null
        scope.launch {
            try {
                tables = withContext(Dispatchers.IO) { Api.service.tables() }
            } catch (e: Exception) {
                error = "Nepodarilo sa načítať stoly. Skontroluj pripojenie k serveru."
            } finally { loading = false }
        }
    }
    LifecycleResumeEffect(Unit) { load(); onPauseOrDispose { } }

    val openCount = tables.count { it.status != "free" }

    Scaffold(
        topBar = {
            Column {
                PosHeader(activeTab = "stoly", userName = AppPrefs.userName,
                    onStoly = { load() }, onLogout = onLogout, onRefresh = { load() })
                ShiftStrip(openTables = openCount, totalTables = tables.size, revenueToday = null)
            }
        }
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                error != null -> Column(
                    Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(error!!, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { load() }) { Text("Skúsiť znova") }
                }
                else -> {
                    val byZone = tables.groupBy { it.zone }
                    LazyColumn(
                        Modifier.fillMaxSize().padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        byZone.forEach { (zone, list) ->
                            item(key = "h_$zone") {
                                Text(
                                    zone.replaceFirstChar { it.uppercase() },
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            item(key = "g_$zone") {
                                val rows = list.chunked(5)
                                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                    rows.forEach { rowItems ->
                                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                            rowItems.forEach { t ->
                                                TableCard(t, Modifier.weight(1f)) { onOpenTable(t.id) }
                                            }
                                            repeat(5 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TableCard(t: TableDto, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val sc = statusColor(t.status)
    val occupied = t.status == "occupied"
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        color = if (occupied) sc.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp,
            if (occupied) sc.copy(alpha = 0.45f) else MaterialTheme.colorScheme.outline),
        tonalElevation = if (occupied) 0.dp else 1.dp,
        modifier = modifier.height(82.dp),
    ) {
        Box(
            Modifier.fillMaxSize()
                .background(Brush.verticalGradient(
                    if (occupied) listOf(sc.copy(alpha = 0.08f), sc.copy(alpha = 0.14f))
                    else listOf(CreamElev, CreamSunken))),
        ) {
            Column(
                Modifier.fillMaxSize().padding(10.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(statusGlyph(t.status), color = sc, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                Text(t.name, style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface)
                Text(statusLabel(t.status), style = MaterialTheme.typography.labelSmall, color = sc)
            }
        }
    }
}
