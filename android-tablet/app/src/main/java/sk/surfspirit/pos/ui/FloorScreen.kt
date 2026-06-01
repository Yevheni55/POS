package sk.surfspirit.pos.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.TableDto
import sk.surfspirit.pos.ui.theme.Danger
import sk.surfspirit.pos.ui.theme.Sage
import sk.surfspirit.pos.ui.theme.Terra

private fun statusColor(s: String): Color = when (s) {
    "occupied" -> Terra
    "reserved" -> Color(0xFFC98A2B)
    "dirty" -> Danger
    else -> Sage          // free
}
private fun statusLabel(s: String): String = when (s) {
    "occupied" -> "obsadený"; "reserved" -> "rezerv."; "dirty" -> "špinavý"; else -> "voľný"
}

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
    LaunchedEffect(Unit) { load() }

    Scaffold(
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Stoly", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.weight(1f))
                    AppPrefs.userName?.let {
                        Text(it, style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(12.dp))
                    }
                    IconButton(onClick = { load() }) { Icon(Icons.Filled.Refresh, "Obnoviť") }
                    IconButton(onClick = onLogout) { Icon(Icons.Filled.Logout, "Odhlásiť") }
                }
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
                                // jednoduchá mriežka v rámci zóny (5 stĺpcov na 10.1")
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
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        modifier = modifier.height(78.dp),
    ) {
        Column(
            Modifier.fillMaxSize().padding(10.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Surface(shape = CircleShape, color = sc, modifier = Modifier.size(9.dp)) {}
            Spacer(Modifier.height(6.dp))
            Text(t.name, style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface)
            Text(statusLabel(t.status), style = MaterialTheme.typography.labelSmall, color = sc)
        }
    }
}
