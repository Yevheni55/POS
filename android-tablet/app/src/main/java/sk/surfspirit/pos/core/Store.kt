package sk.surfspirit.pos.core

import androidx.compose.runtime.mutableStateOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.CategoryDto
import sk.surfspirit.pos.net.MenuItemDto
import sk.surfspirit.pos.net.StornoBasketReq
import sk.surfspirit.pos.net.TableDto
import sk.surfspirit.pos.net.ZoneDto

/**
 * Lokálna (ešte neodoslaná) položka v košíku — zdieľaná medzi OrderScreen
 * a draft persistenciou (web parita: pos_tableOrders v localStorage, takže
 * rozpísaný účet prežije reštart appky aj návrat na plán stolov).
 */
@Serializable
data class CartLine(
    val uid: Long = 0,               // lokálne id riadku (linkovanie companion/annotation)
    val menuItemId: Int,
    val name: String,
    val emoji: String,
    val price: Double,
    val qty: Int,
    val note: String = "",
    val companionOfUid: Long? = null, // uid primárneho riadku (záloha fľaša, omáčka)
    val noMerge: Boolean = false,     // combo s omáčkou — nikdy nemergovať riadky
)

/** Neúspešný DELETE položky — zopakuje sa pred ďalším syncom (web _pendingRemovals). */
@Serializable
data class PendingRemoval(val orderId: Int, val itemId: Long)

/** Globálny online/offline stav + počet čakajúcich operácií (banner). */
object Net {
    val offline = mutableStateOf(false)
    val queueCount = mutableStateOf(0)
}

/**
 * Offline cache + draft persistencia (web parita: pos_menu_cache,
 * pos_tables_cache, pos_topItems_v1, pos_tableOrders, pos_offline_queue).
 * Všetko JSON v SharedPreferences cez AppPrefs.
 */
object Store {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; isLenient = true }

    private const val K_MENU = "cache_menu"
    private const val K_TABLES = "cache_tables"
    private const val K_ZONES = "cache_zones"
    private const val K_TOP = "cache_top"
    private const val K_DRAFTS = "draft_carts"
    private const val K_STORNO_Q = "queue_storno"
    private const val K_REMOVALS_Q = "queue_removals"
    private const val K_LAST_TABLE = "ui_last_table"
    private const val K_LAST_CAT = "ui_last_category"

    /* ---------- cache (menu / stoly / zóny / top) ---------- */

    fun cacheMenu(data: List<CategoryDto>) = put(K_MENU, json.encodeToString(ListSerializer(CategoryDto.serializer()), data))
    fun cachedMenu(): List<CategoryDto>? = getList(K_MENU, CategoryDto.serializer())

    fun cacheTables(data: List<TableDto>) = put(K_TABLES, json.encodeToString(ListSerializer(TableDto.serializer()), data))
    fun cachedTables(): List<TableDto>? = getList(K_TABLES, TableDto.serializer())

    fun cacheZones(data: List<ZoneDto>) = put(K_ZONES, json.encodeToString(ListSerializer(ZoneDto.serializer()), data))
    fun cachedZones(): List<ZoneDto>? = getList(K_ZONES, ZoneDto.serializer())

    fun cacheTop(data: List<MenuItemDto>) = put(K_TOP, json.encodeToString(ListSerializer(MenuItemDto.serializer()), data))
    fun cachedTop(): List<MenuItemDto>? = getList(K_TOP, MenuItemDto.serializer())

    /* ---------- draft košíky per stôl ---------- */

    private val draftsSer = MapSerializer(String.serializer(), ListSerializer(CartLine.serializer()))

    // Dekódovaná mapa draftov ostáva v pamäti — saveDraft beží na každý tap
    // košíka (hold-to-repeat každých 150 ms) a opakovaný decode celého JSON-u
    // by bol zbytočný jank na main threade. Načíta sa lenivo raz, zápis ide
    // z cache (encode + apply(), žiadny re-decode). Prístup pod draftsLock
    // (rovnaký štýl ako qLock pre fronty).
    private val draftsLock = Any()
    private var draftsCache: MutableMap<String, List<CartLine>>? = null

    private fun draftsLocked(): MutableMap<String, List<CartLine>> =
        draftsCache ?: (AppPrefs.getRaw(K_DRAFTS)?.let {
            try { json.decodeFromString(draftsSer, it).toMutableMap() } catch (_: Exception) { mutableMapOf() }
        } ?: mutableMapOf()).also { draftsCache = it }

    // Persist draftov je debounced na pozadí — encode celej mapy + commit na
    // každý tap košíka (hold-to-repeat 150 ms) by bol jank na main threade.
    // draftsCache je zdroj pravdy; drafty sú len restart-convenience, takže
    // strata max. ~300 ms okna pri zabití procesu je prijateľná.
    private val persistScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var persistJob: Job? = null   // prístup len pod draftsLock

    fun saveDraft(tableId: Int, lines: List<CartLine>) = synchronized(draftsLock) {
        val all = draftsLocked()
        if (lines.isEmpty()) all.remove(tableId.toString()) else all[tableId.toString()] = lines.toList()
        persistJob?.cancel()
        persistJob = persistScope.launch {
            delay(300)
            synchronized(draftsLock) {
                // cancel z clearAll beží pod draftsLock — zrušený job tu už
                // nesmie zapísať, inak by wipe „vzkriesil" staré drafty
                if (!isActive) return@launch
                put(K_DRAFTS, json.encodeToString(draftsSer, draftsLocked()))
            }
        }
    }

    fun loadDraft(tableId: Int): List<CartLine> =
        synchronized(draftsLock) { draftsLocked()[tableId.toString()] ?: emptyList() }

    /** Stoly s rozpísaným draftom (na floor chip "occupied" indikáciu). */
    fun draftTableIds(): Set<Int> =
        synchronized(draftsLock) { draftsLocked().keys.mapNotNull { it.toIntOrNull() }.toSet() }

    /* ---------- UI state restore (web pos_uiState) ---------- */

    fun saveLastTable(tableId: Int?) = put(K_LAST_TABLE, tableId?.toString() ?: "")
    fun lastTable(): Int? = AppPrefs.getRaw(K_LAST_TABLE)?.toIntOrNull()
    fun saveLastCategory(idx: Int) = put(K_LAST_CAT, idx.toString())
    fun lastCategory(): Int = AppPrefs.getRaw(K_LAST_CAT)?.toIntOrNull() ?: 0

    /* ---------- offline queue (storno kôš + delete retry) ---------- */

    private val stornoQSer = ListSerializer(StornoBasketReq.serializer())
    private val removalsQSer = ListSerializer(PendingRemoval.serializer())

    // Všetky čítania/zápisy frontov pod jedným zámkom — queueStorno počas
    // flushQueue nesmie byť prepísaný save-om frontu načítaného pred ním.
    private val qLock = Any()
    @Volatile private var flushing = false

    private fun loadStornoQueue(): MutableList<StornoBasketReq> =
        AppPrefs.getRaw(K_STORNO_Q)?.let {
            try { json.decodeFromString(stornoQSer, it).toMutableList() } catch (_: Exception) { mutableListOf() }
        } ?: mutableListOf()

    private fun loadRemovalsQueue(): MutableList<PendingRemoval> =
        AppPrefs.getRaw(K_REMOVALS_Q)?.let {
            try { json.decodeFromString(removalsQSer, it).toMutableList() } catch (_: Exception) { mutableListOf() }
        } ?: mutableListOf()

    fun queueStorno(req: StornoBasketReq) = synchronized(qLock) {
        val q = loadStornoQueue(); q.add(req)
        put(K_STORNO_Q, json.encodeToString(stornoQSer, q))
        refreshQueueCountLocked()
    }

    fun queueRemoval(orderId: Int, itemId: Long) = synchronized(qLock) {
        val q = loadRemovalsQueue(); q.add(PendingRemoval(orderId, itemId))
        put(K_REMOVALS_Q, json.encodeToString(removalsQSer, q))
        refreshQueueCountLocked()
    }

    private fun refreshQueueCountLocked() {
        Net.queueCount.value = loadStornoQueue().size + loadRemovalsQueue().size
    }

    fun refreshQueueCount() = synchronized(qLock) { refreshQueueCountLocked() }

    /** Počet neodoslaných operácií (storno kôš + delete retry) — UI gate
     *  pred akciami, ktoré fronty nenávratne mažú (zmena server URL). */
    fun pendingOpsCount(): Int = synchronized(qLock) { loadStornoQueue().size + loadRemovalsQueue().size }

    /**
     * Replay čakajúcich operácií po obnove spojenia. 4xx (okrem 429; pri
     * storne aj 403) sa zahodí (replay to nevyrieši), transport/5xx ostáva
     * vo fronte.
     * Sieťové volania bežia MIMO zámku; každý úspech sa odoberá z aktuálne
     * uloženého frontu individuálne (žiadny bulk-overwrite). Súbežný flush
     * je no-op cez `flushing` flag — žiadne dvojité odoslanie.
     */
    suspend fun flushQueue() {
        // check-and-set atomicky pod zámkom — dva súbežné flush-e (floor +
        // order screen) nesmú POSTnúť ten istý snapshot dvakrát
        synchronized(qLock) {
            if (flushing) return
            flushing = true
        }
        try {
            val stornoSnapshot = synchronized(qLock) { loadStornoQueue().toList() }
            for (req in stornoSnapshot) {
                val drop = try { Api.service.stornoBasket(req); true }
                catch (e: Exception) {
                    val code = e.httpCode()
                    // 403 = role-gate (čašnícka session na staršom serveri) —
                    // storno záznam sa NIKDY nesmie stratiť; ostáva vo fronte,
                    // kým ho flushne manažérska session.
                    !(e.isTransportError() || code == 429 || code == 403 || (code ?: 0) >= 500)
                }
                if (drop) synchronized(qLock) {
                    val q = loadStornoQueue()
                    val i = q.indexOfFirst { it == req }
                    if (i >= 0) { q.removeAt(i); put(K_STORNO_Q, json.encodeToString(stornoQSer, q)) }
                    refreshQueueCountLocked()
                }
            }
            val removalsSnapshot = synchronized(qLock) { loadRemovalsQueue().toList() }
            for (r in removalsSnapshot) {
                // 404 = už zmazané/objednávka preč → hotovo; iné 4xx zahoď tiež
                val drop = try { Api.service.deleteItem(r.orderId, r.itemId); true }
                catch (e: Exception) {
                    val code = e.httpCode()
                    !(e.isTransportError() || code == 429 || (code ?: 0) >= 500)
                }
                if (drop) synchronized(qLock) {
                    val q = loadRemovalsQueue()
                    val i = q.indexOfFirst { it == r }
                    if (i >= 0) { q.removeAt(i); put(K_REMOVALS_Q, json.encodeToString(removalsQSer, q)) }
                    refreshQueueCountLocked()
                }
            }
        } finally { flushing = false }
    }

    /**
     * Kompletný wipe lokálneho stavu — iný server = iná DB; staré drafty/cache
     * (menuItemId z cudzej databázy) sú nebezpečné. Volá AppPrefs pri zmene
     * server URL.
     */
    fun clearAll() {
        synchronized(draftsLock) {
            persistJob?.cancel()   // čakajúci debounce zápis nesmie wipe prepísať
            persistJob = null
            draftsCache = null
            AppPrefs.removeRaw(K_DRAFTS)
        }
        synchronized(qLock) {
            AppPrefs.removeRaw(K_STORNO_Q)
            AppPrefs.removeRaw(K_REMOVALS_Q)
            Net.queueCount.value = 0
        }
        listOf(K_MENU, K_TABLES, K_ZONES, K_TOP, K_LAST_TABLE, K_LAST_CAT).forEach { AppPrefs.removeRaw(it) }
    }

    /* ---------- helpers ---------- */

    private fun put(key: String, value: String) = AppPrefs.putRaw(key, value)

    private fun <T> getList(key: String, ser: kotlinx.serialization.KSerializer<T>): List<T>? =
        AppPrefs.getRaw(key)?.let {
            try { json.decodeFromString(ListSerializer(ser), it) } catch (_: Exception) { null }
        }
}
