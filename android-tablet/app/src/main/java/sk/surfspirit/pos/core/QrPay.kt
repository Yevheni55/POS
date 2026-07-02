package sk.surfspirit.pos.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.PayReq
import sk.surfspirit.pos.net.QrCreateResp

/**
 * Registry bežiacich QR platieb (Portos PayMe) — web parita _qrPayments.
 *
 * ČAKANIE NA ÚHRADU BEŽÍ NA POZADÍ: dialóg možno zavrieť („Na pozadí"),
 * pooling pokračuje v application-scope korutine a po úhrade (status paid
 * z bankovej notifikácie) sa fiškálny doklad vystaví AUTOMATICKY štandardným
 * POST /payments { method:'prevod' } — aj keď je obsluha na inom účte alebo
 * na podlaží. Kým notifikácia nefunguje, obsluha potvrdí ručne („Zaplatené").
 *
 * PERZISTENCIA: entries sa zrkadlia do prefs (Store) — vytlačený QR bonček
 * ostáva zaplatiteľný aj po páde/reštarte appky, takže po štarte treba
 * pooling OBNOVIŤ (restore() v MainActivity), inak by vznikli peniaze na
 * účte bez fiškálneho dokladu.
 *
 * UDALOSTI: keď práve nikto nepočúva (obsluha v Admine/Dochádzke), udalosti
 * sa NEstrácajú — odkladajú sa do backlogu a najbližší collector si ich
 * vyzdvihne cez collectEvents() (drain + live).
 *
 * Pooling: 2,5 s; po 5 chybách za sebou spomalí na 6 s (web parita).
 * Idempotencia finalizácie: kľúč "qr-<transactionId>" — auto, manuálne
 * potvrdenie aj retry po reštarte zdieľajú TEN ISTÝ kľúč, server pri
 * súbehu/replayi vráti výsledok namiesto druhého dokladu.
 */
object QrPay {
    @Serializable
    data class Entry(
        val transactionId: String,
        val orderId: Int,
        val amount: Double,
        val tableId: Int,
        val tableName: String,
        val expiresAt: String?,
        val printed: Boolean,
        val qrDataUrl: String?,
        val finalizing: Boolean = false,
        val expired: Boolean = false,
    )

    sealed class Event {
        /** Doklad vystavený (auto z poolingu alebo manuálne Zaplatené). */
        data class Paid(val entry: Entry, val message: String) : Event()
        /** QR vypršal nezaplatený — UI rozhodne: dialóg otvorený = správa, inak toast+remove. */
        data class Expired(val entry: Entry) : Event()
        /** Fiškalizácia po úhrade zlyhala / vyžaduje kontrolu. removed=true → entry už nie je v registry. */
        data class FinalizeProblem(val entry: Entry, val message: String, val removed: Boolean) : Event()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = mutableMapOf<String, Job>()

    private val _entries = MutableStateFlow<List<Entry>>(emptyList())
    val entries = _entries.asStateFlow()

    // Živé udalosti + backlog pre chvíle bez collectora (Admin/Dochádzka/reštart).
    // subscriptionCount rozhoduje, kam udalosť ide — collectEvents() najprv
    // vyprázdni backlog, potom počúva živý stream.
    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 16)
    private val backlog = ArrayDeque<Event>()
    private val backlogLock = Any()

    private fun emitEvent(ev: Event) {
        if (_events.subscriptionCount.value > 0) {
            _events.tryEmit(ev)
        } else synchronized(backlogLock) {
            backlog.addLast(ev)
            while (backlog.size > 16) backlog.removeFirst()
        }
    }

    /** Jediný vstup pre UI: najprv zmeškané udalosti (backlog), potom živé. */
    suspend fun collectEvents(handler: suspend (Event) -> Unit) {
        val missed = synchronized(backlogLock) {
            val copy = backlog.toList(); backlog.clear(); copy
        }
        missed.forEach { handler(it) }
        _events.collect { handler(it) }
    }

    fun find(tx: String): Entry? = _entries.value.firstOrNull { it.transactionId == tx }

    fun forOrder(orderId: Int): Entry? = _entries.value.firstOrNull { it.orderId == orderId }

    private fun persist() {
        // qrDataUrl (base64 PNG ~pár KB) sa persistuje tiež — po reštarte sa
        // dialóg vie znova ukázať aj s obrazovkovým QR fallbackom.
        Store.saveQrPending(_entries.value.map { it.copy(finalizing = false) })
    }

    /**
     * Obnov pooling po reštarte procesu — volá MainActivity po AppPrefs.init.
     * Finalizácia je idempotentná (qr-<tx>), takže aj QR zaplatený POČAS
     * výpadku appky sa doriši prvým poll tickom.
     */
    fun restore() {
        val saved = Store.loadQrPending()
        if (saved.isEmpty()) return
        _entries.value = saved
        saved.forEach { e ->
            jobs.remove(e.transactionId)?.cancel()
            jobs[e.transactionId] = scope.launch { pollLoop(e.transactionId) }
        }
    }

    /** Zaregistruj novú QR platbu a spusti background pooling. */
    fun start(resp: QrCreateResp, tableId: Int, tableName: String) {
        val entry = Entry(
            transactionId = resp.transactionId,
            orderId = resp.orderId,
            amount = resp.amount,
            tableId = tableId,
            tableName = tableName,
            expiresAt = resp.expiresAt,
            printed = resp.printed,
            qrDataUrl = resp.qrDataUrl,
        )
        _entries.value = _entries.value.filter { it.transactionId != entry.transactionId } + entry
        persist()
        jobs.remove(entry.transactionId)?.cancel()
        jobs[entry.transactionId] = scope.launch { pollLoop(entry.transactionId) }
    }

    /** Zruš QR platbu (obsluha „Zrušiť" / vypršané / účet zaplatený inak). */
    fun cancel(tx: String) {
        jobs.remove(tx)?.cancel()
        _entries.value = _entries.value.filter { it.transactionId != tx }
        persist()
    }

    /**
     * Účet sa uzavrel INOU cestou (hotovosť/karta/odpis/zrušenie) — visiaci QR
     * pre ten účet už nemá čo finalizovať; zhoď ho, nech nevznikne druhý doklad.
     */
    fun cancelForOrder(orderId: Int) {
        forOrder(orderId)?.let { cancel(it.transactionId) }
    }

    /** Manuálne „Zaplatené" — obsluha videla úhradu (napr. v banke) skôr než pooling. */
    fun confirmManually(tx: String) {
        scope.launch { finalize(tx) }
    }

    /** Znovu vytlač QR bonček (zaseknutý papier a pod.). */
    suspend fun reprint(tx: String): Boolean =
        try { Api.service.qrRender(tx).isSuccessful } catch (_: Exception) { false }

    private fun update(tx: String, f: (Entry) -> Entry) {
        _entries.value = _entries.value.map { if (it.transactionId == tx) f(it) else it }
    }

    private suspend fun pollLoop(tx: String) {
        var errStreak = 0
        while (true) {
            delay(if (errStreak >= 5) 6_000L else 2_500L)
            val entry = find(tx) ?: return          // zrušené / finalizované
            if (entry.finalizing || entry.expired) continue
            try {
                val st = Api.service.qrStatus(tx)
                errStreak = 0
                if (find(tx) == null) return
                if (st.paid) { finalize(tx); return }
                if (st.final) {
                    // expired — pooling končí; ak nikto nepočúva, event čaká v backlogu
                    update(tx) { it.copy(expired = true) }
                    find(tx)?.let { emitEvent(Event.Expired(it)) }
                    return
                }
            } catch (_: Exception) {
                // Strata spojenia sa nevzdáva natvrdo (platba môže doraziť) — len spomalí.
                errStreak += 1
            }
        }
    }

    /** 409 + „processing" = idempotency kľúč rezervovaný, PRVÁ požiadavka beží. */
    private fun isPayProcessing(e: Exception): Boolean =
        e.httpCode() == 409 && e.errorBody()?.contains("processing") == true

    /** Vystav fiškálny doklad (method='prevod') — zdieľané auto aj manuálnou cestou. */
    private suspend fun finalize(tx: String) {
        val entry = find(tx) ?: return
        if (entry.finalizing) return
        update(tx) { it.copy(finalizing = true) }
        val payKey = "qr-$tx"
        val payReq = PayReq(orderId = entry.orderId, method = "prevod", amount = entry.amount)
        try {
            var resp = try {
                Api.service.pay(payKey, payReq)
            } catch (pe: Exception) {
                // Kľúč rezervovaný (súbeh auto+manuál / retry po reštarte) —
                // počkaj na výsledok PRVEJ požiadavky s TÝM ISTÝM kľúčom.
                if (!isPayProcessing(pe)) throw pe
                var waited: sk.surfspirit.pos.net.PayResp? = null
                val deadline = System.currentTimeMillis() + 30_000
                while (System.currentTimeMillis() < deadline) {
                    delay(2_500)
                    try { waited = Api.service.pay(payKey, payReq); break }
                    catch (re: Exception) { if (!isPayProcessing(re) && !re.isTimeout()) throw re }
                }
                waited ?: throw pe
            }
            // Účet už medzitým zaplatili INOU metódou (hotovosť/karta) — server
            // vrátil cudzí doklad cez idempotentný replay ČI order-level guard.
            // NIE JE to úspech QR: zákazník mohol zaplatiť dvakrát!
            val paidMethod = resp.payment?.method
            if (resp.alreadyProcessed && paidMethod != null && paidMethod != "prevod") {
                cancel(tx)
                emitEvent(Event.FinalizeProblem(entry,
                    "${entry.tableName}: účet už bol zaplatený inak (${paidMethod}) — over duplicitnú QR úhradu v banke.",
                    removed = true))
                return
            }
            val outcome = normalizeFiscalOutcome(resp, null)
            when (outcome.kind) {
                "success", "offline_accepted", "no_fiscal" -> {
                    cancel(tx)
                    emitEvent(Event.Paid(entry, "✓ ${entry.tableName} zaplatený cez QR — doklad vytlačený"))
                }
                else -> {
                    // blocked/ambiguous — platba ostáva v registry na retry (web parita);
                    // ŽIADEN paragón (QR vetva ho zámerne neponúka).
                    update(tx) { it.copy(finalizing = false) }
                    emitEvent(Event.FinalizeProblem(entry,
                        "QR (${entry.tableName}): ${outcome.message.ifBlank { "fiškalizácia vyžaduje kontrolu" }}",
                        removed = false))
                }
            }
        } catch (e: Exception) {
            val outcome = normalizeFiscalOutcome(null, e)
            update(tx) { it.copy(finalizing = false) }
            val msg = if (outcome.kind == "conflict")
                "QR (${entry.tableName}): ${outcome.message}"
            else
                "${entry.tableName}: QR zaplatený, ale doklad zlyhal — over ručne. ${errorMessage(e)}"
            emitEvent(Event.FinalizeProblem(entry, msg, removed = false))
        }
    }
}
