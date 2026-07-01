package sk.surfspirit.pos.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
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
 * Pooling: 2,5 s; po 5 chybách za sebou spomalí na 6 s (web parita).
 * Idempotencia finalizácie: kľúč "qr-<transactionId>" — auto aj manuálne
 * potvrdenie zdieľajú TEN ISTÝ kľúč, server pri súbehu replayne výsledok
 * namiesto druhého dokladu.
 */
object QrPay {
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
        /** Fiškalizácia po úhrade zlyhala / vyžaduje kontrolu — entry OSTÁVA v registry. */
        data class FinalizeProblem(val entry: Entry, val message: String, val removed: Boolean) : Event()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = mutableMapOf<String, Job>()

    private val _entries = MutableStateFlow<List<Entry>>(emptyList())
    val entries = _entries.asStateFlow()

    // extraBufferCapacity: emit z IO korutiny nesmie čakať na collectora
    // (screen môže byť práve v rekompozícii) — udalosti sa nesmú stratiť.
    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 16)
    val events = _events.asSharedFlow()

    fun find(tx: String): Entry? = _entries.value.firstOrNull { it.transactionId == tx }

    fun forOrder(orderId: Int): Entry? = _entries.value.firstOrNull { it.orderId == orderId }

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
        jobs.remove(entry.transactionId)?.cancel()
        jobs[entry.transactionId] = scope.launch { pollLoop(entry.transactionId) }
    }

    /** Zruš QR platbu (obsluha „Zrušiť" / vypršané) — zastaví pooling. */
    fun cancel(tx: String) {
        jobs.remove(tx)?.cancel()
        _entries.value = _entries.value.filter { it.transactionId != tx }
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
                    // expired — pooling končí, o odstránení rozhodne UI
                    update(tx) { it.copy(expired = true) }
                    find(tx)?.let { _events.tryEmit(Event.Expired(it)) }
                    return
                }
            } catch (_: Exception) {
                // Strata spojenia sa nevzdáva natvrdo (platba môže doraziť) — len spomalí.
                errStreak += 1
            }
        }
    }

    /** Vystav fiškálny doklad (method='prevod') — zdieľané auto aj manuálnou cestou. */
    private suspend fun finalize(tx: String) {
        val entry = find(tx) ?: return
        if (entry.finalizing) return
        update(tx) { it.copy(finalizing = true) }
        try {
            val resp = Api.service.pay(
                idempotencyKey = "qr-$tx",
                body = PayReq(orderId = entry.orderId, method = "prevod", amount = entry.amount),
            )
            val outcome = normalizeFiscalOutcome(resp, null)
            when (outcome.kind) {
                "success", "offline_accepted", "no_fiscal" -> {
                    cancel(tx)
                    _events.tryEmit(Event.Paid(entry, "✓ ${entry.tableName} zaplatený cez QR — doklad vytlačený"))
                }
                else -> {
                    // blocked/ambiguous — platba ostáva v registry na retry (web parita);
                    // ŽIADEN paragón (QR vetva ho zámerne neponúka).
                    update(tx) { it.copy(finalizing = false) }
                    _events.tryEmit(Event.FinalizeProblem(entry,
                        "QR (${entry.tableName}): ${outcome.message.ifBlank { "fiškalizácia vyžaduje kontrolu" }}",
                        removed = false))
                }
            }
        } catch (e: Exception) {
            val outcome = normalizeFiscalOutcome(null, e)
            if (outcome.kind == "conflict") {
                // 409 = objednávka sa medzitým zmenila (iný terminál?) — nechaj na retry
                update(tx) { it.copy(finalizing = false) }
                _events.tryEmit(Event.FinalizeProblem(entry,
                    "QR (${entry.tableName}): ${outcome.message}", removed = false))
            } else {
                update(tx) { it.copy(finalizing = false) }
                _events.tryEmit(Event.FinalizeProblem(entry,
                    "${entry.tableName}: QR zaplatený, ale doklad zlyhal — over ručne. ${errorMessage(e)}",
                    removed = false))
            }
        }
    }
}
