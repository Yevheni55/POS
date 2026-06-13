package sk.surfspirit.pos.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.BuildConfig
import sk.surfspirit.pos.core.AppPrefs
import java.util.concurrent.TimeUnit

/* ===================== DTOs (zhoda s /api shape) ===================== */

@Serializable data class LoginReq(val pin: String)
@Serializable data class UserDto(val id: Int, val name: String, val role: String)
@Serializable data class LoginResp(val token: String, val user: UserDto)

@Serializable data class ManagerVerifyReq(val pin: String)
@Serializable data class ManagerVerifyResp(val ok: Boolean = false, val name: String = "", val token: String = "")

@Serializable data class TableDto(
    val id: Int,
    val name: String = "",
    val seats: Int = 4,
    val zone: String = "interior",
    val shape: String = "rect",
    val status: String = "free",          // free | occupied | reserved | dirty
    val time: String? = null,
    // Spatial floor plan — rovnaké súradnice ako admin/web (px na canvase).
    val x: Int = 0,
    val y: Int = 0,
    val width: Int? = null,               // null = default zo shape
    val height: Int? = null,
)

@Serializable data class TableUpdateReq(
    val x: Int,
    val y: Int,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable data class ZoneDto(val slug: String = "", val label: String = "")

@Serializable data class MenuItemDto(
    val id: Int,
    val name: String = "",
    val emoji: String = "",
    val price: Double = 0.0,
    val categoryId: Int = 0,
    val categorySlug: String = "",
    val desc: String = "",
    val active: Boolean = true,
    val available: Boolean = true,
    val destOverride: String? = null,             // "bar" | "kuchyna" | null
    val companionMenuItemId: Int? = null,
    val vatRate: Double? = null,
    val totalQty: Int = 0,                         // pre /menu/top ranking
)

@Serializable data class CategoryDto(
    val id: Int,
    val slug: String = "",
    val label: String = "",
    val icon: String = "",
    val dest: String = "bar",             // bar | kuchyna
    val items: List<MenuItemDto> = emptyList(),
)

@Serializable data class OrderItemDto(
    val id: Long = 0,
    val menuItemId: Int = 0,
    val name: String = "",
    val emoji: String = "",
    val qty: Int = 0,
    val price: Double = 0.0,
    val note: String = "",
    val sent: Boolean = false,
    val desc: String = "",
)

@Serializable data class OrderDto(
    val id: Int,
    val tableId: Int = 0,
    val label: String = "",
    val version: Int = 0,
    val status: String = "open",
    val total: Double = 0.0,
    val totalAfterDiscount: Double = 0.0,
    val discountId: Int? = null,
    val discountAmount: Double? = null,
    val createdAt: String? = null,        // ISO — pre „zabudnutý stôl" indikátor
    val items: List<OrderItemDto> = emptyList(),
) {
    /** Subtotal počítaný z položiek (nezávislý od server total poľa). */
    val subtotal: Double get() = items.sumOf { it.price * it.qty }
    val discount: Double get() = discountAmount ?: 0.0
    /** Celková suma po zľave. */
    val grandTotal: Double get() = (subtotal - discount).coerceAtLeast(0.0)
}

@Serializable data class DiscountDto(
    val id: Int,
    val name: String = "",
    val type: String = "percent",   // percent | fixed
    val value: Double = 0.0,
)

@Serializable data class NewItem(val menuItemId: Int, val qty: Int, val note: String = "")
@Serializable data class CreateOrderReq(val tableId: Int, val items: List<NewItem>, val label: String? = null)
@Serializable data class AddItemsReq(val items: List<NewItem>, val version: Int? = null)
@Serializable data class UpdateItemReq(val qty: Int? = null, val note: String? = null, val version: Int? = null)

@Serializable data class SendReq(val overrideLimit: Boolean = false)
@Serializable data class MarkedItemDto(
    val id: Long = 0,
    val menuItemId: Int = 0,
    val name: String = "",
    val emoji: String = "",
    val qty: Int = 0,
    val note: String = "",
)
@Serializable data class SendResp(val printed: Int = 0, val items: List<MarkedItemDto> = emptyList(), val markedItems: List<MarkedItemDto> = emptyList())
@Serializable data class StornoSendReq(val items: List<NewItem>)

@Serializable data class SplitPartsReq(val parts: Int)
@Serializable data class SplitGroupsReq(val itemGroups: List<List<Long>>)
@Serializable data class SplitResp(val newOrderIds: List<Int> = emptyList())

@Serializable data class MoveQty(val itemId: Long, val qty: Int? = null)
@Serializable data class MoveReq(
    val itemQtys: List<MoveQty>? = null,
    val itemIds: List<Long>? = null,
    val targetTableId: Int? = null,
    val targetOrderId: Int? = null,
)
@Serializable data class MoveResp(val movedItems: List<Long> = emptyList(), val targetOrderId: Int = 0)

@Serializable data class DiscountReq(val discountId: Int? = null, val customPercent: Double? = null, val version: Int? = null)
@Serializable data class CloseReq(val version: Int? = null)
@Serializable data class StaffMealReq(val version: Int? = null, val overrideLimit: Boolean = false)
@Serializable data class StaffMealResp(val totalCogs: String? = null)

@Serializable data class PayReq(val orderId: Int, val method: String, val amount: Double)
@Serializable data class PaymentDto(val id: Int = 0, val orderId: Int = 0, val method: String = "", val amount: String = "0", val createdAt: String = "")
@Serializable data class FiscalDto(
    val status: String = "",
    val isSuccessful: Boolean? = null,
    val externalId: String? = null,
    val errorDetail: String? = null,
    val errorCode: String? = null,
    val copyAvailable: Boolean? = null,
)
@Serializable data class PayResp(
    val payment: PaymentDto? = null,
    val order: OrderDto? = null,
    val fiscal: FiscalDto? = null,
    val alreadyProcessed: Boolean = false,
)

@Serializable data class ShiftDto(
    val id: Int = 0,
    val staffId: Int = 0,
    val status: String = "open",
    val openingCash: String? = null,
    val closingCash: String? = null,
    val openedAt: String? = null,
    val closedAt: String? = null,
)
@Serializable data class ShiftSummaryDto(
    val shift: ShiftDto? = null,
    val openingCash: Double = 0.0,
    val cashPayments: Double = 0.0,
    val expectedCash: Double = 0.0,
)
@Serializable data class OpenShiftReq(val openingCash: Double = 0.0)
@Serializable data class CloseShiftReq(val closingCash: Double = 0.0)
@Serializable data class CloseShiftResp(
    val shift: ShiftDto? = null,
    val openingCash: Double = 0.0,
    val cashPayments: Double = 0.0,
    val expectedCash: Double = 0.0,
    val actualCash: Double = 0.0,
    val difference: Double = 0.0,
)
@Serializable data class ZReportDto(val totalRevenue: Double = 0.0)

@Serializable data class PrintItem(
    val qty: Int = 0,
    val name: String = "",
    val note: String = "",
    val price: Double = 0.0,
    val emoji: String = "",
)
@Serializable data class PrintKitchenReq(
    val dest: String,
    val tableName: String,
    val staffName: String,
    val items: List<PrintItem>,
    val orderNum: Int? = null,
)
@Serializable data class PreBillReq(
    val tableName: String,
    val staffName: String,
    val items: List<PrintItem>,
    val total: Double,
    val subtotal: Double = 0.0,
    val discount: Double = 0.0,
    val orderNum: Int? = null,
)
@Serializable data class PrintOk(val ok: Boolean = false, val queued: Boolean = false)

/* ---- Paragón (offline fallback, § 10 z. 289/2008) ---- */
@Serializable data class ParagonItem(
    val id: Long? = null,
    val name: String,
    val qty: Int,
    val price: Double,
    val vatRate: Double = 0.0,
    val note: String = "",
)
@Serializable data class ParagonIssueReq(
    val orderId: Int? = null,
    val items: List<ParagonItem>,
    val paymentMethod: String,
    val totalAmount: Double,
    val discountAmount: Double = 0.0,
    val reason: String = "portos_unavailable",
)
@Serializable data class ParagonIssueResp(
    val ok: Boolean = false,
    val paragonId: Int = 0,
    val paragonNumber: String = "",
)
@Serializable data class ParagonPrintReq(
    val paragonNumber: String,
    val tableName: String? = null,
    val staffName: String = "",
    val items: List<ParagonItem>,
    val total: Double,
    val method: String,
    val vatRate: Double? = null,     // non-payer DPH → null (žiadny VAT riadok)
    val companyName: String? = null,
)

/* ---- Storno kôš (dôvod storna pre admin) ---- */
@Serializable data class StornoBasketReq(
    val menuItemId: Int,
    val qty: Int,
    val name: String,
    val unitPrice: Double = 0.0,
    val reason: String,              // order_error | complaint | breakage | staff_meal | other
    val note: String = "",
    val wasPrepared: Boolean = true,
    val orderId: Int? = null,
)

/* ---- TTLock kód zámku ---- */
@Serializable data class TtlockResp(val passcode: String = "", val endDate: String = "")
@Serializable data class LockCodePrintReq(
    val code: String,
    val validUntil: String,
    val staffName: String = "",
)

@Serializable class Empty   // ignoreUnknownKeys → pohltí ľubovoľnú odpoveď

// Auto-update manifest (hostovaný na kase: /api/app/latest)
@Serializable data class UpdateInfo(
    val versionCode: Int = 0,
    val versionName: String = "",
    val url: String = "",
    val notes: String = "",
    val sha256: String = "",          // SHA-256 APK — overenie integrity pred inštaláciou
    val minVersionCode: Int = 0,      // pod túto verziu je update povinný (gate)
)

/* ===================== API service ===================== */

interface ApiService {
    @POST("api/auth/login")
    suspend fun login(@Body body: LoginReq): LoginResp

    @POST("api/auth/verify-manager")
    suspend fun verifyManager(@Body body: ManagerVerifyReq): ManagerVerifyResp

    @GET("api/tables")
    suspend fun tables(): List<TableDto>

    @GET("api/zones")
    suspend fun zones(): List<ZoneDto>

    @GET("api/menu")
    suspend fun menu(): List<CategoryDto>

    @GET("api/menu/top")
    suspend fun menuTop(): List<MenuItemDto>

    @GET("api/discounts")
    suspend fun discounts(): List<DiscountDto>

    // Objednávky
    @GET("api/orders")
    suspend fun allOrders(): List<OrderDto>

    @GET("api/orders/table/{id}")
    suspend fun tableOrders(@Path("id") tableId: Int): List<OrderDto>

    // X-Idempotency-Key: retry rovnakého syncu po výpadku NEduplikuje položky —
    // server (middleware/idempotency.js) vráti cached odpoveď namiesto re-insertu.
    @POST("api/orders")
    suspend fun createOrder(
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
        @Body body: CreateOrderReq,
    ): OrderDto

    // Pozn.: server vracia 201 + POLE vložených riadkov → JsonElement (nie Empty,
    // ktoré dekóduje len objekt — pole by hodilo výnimku PO úspešnom inserte).
    @POST("api/orders/{id}/items")
    suspend fun addItems(
        @Path("id") orderId: Int,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
        @Body body: AddItemsReq,
    ): JsonElement

    @PUT("api/orders/{orderId}/items/{itemId}")
    suspend fun updateItem(@Path("orderId") orderId: Int, @Path("itemId") itemId: Long, @Body body: UpdateItemReq): JsonElement

    @DELETE("api/orders/{orderId}/items/{itemId}")
    suspend fun deleteItem(@Path("orderId") orderId: Int, @Path("itemId") itemId: Long): JsonElement

    @POST("api/orders/{id}/send-and-print")
    suspend fun sendAndPrint(
        @Path("id") orderId: Int,
        @Body body: SendReq,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
    ): SendResp

    // X-Elevated: role-gated volanie — authInterceptor preň použije elevated
    // token po manager PIN (hlavičku pred odoslaním odstráni).
    @retrofit2.http.Headers("X-Elevated: 1")
    @POST("api/orders/{id}/send-storno-and-print")
    suspend fun sendStornoAndPrint(@Path("id") orderId: Int, @Body body: StornoSendReq): SendResp

    @POST("api/orders/{id}/split")
    suspend fun splitParts(
        @Path("id") orderId: Int,
        @Body body: SplitPartsReq,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
    ): SplitResp

    @POST("api/orders/{id}/split")
    suspend fun splitGroups(
        @Path("id") orderId: Int,
        @Body body: SplitGroupsReq,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
    ): SplitResp

    @POST("api/orders/{id}/move-items")
    suspend fun moveItems(
        @Path("id") orderId: Int,
        @Body body: MoveReq,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
    ): MoveResp

    @retrofit2.http.Headers("X-Elevated: 1")
    @POST("api/orders/{id}/discount")
    suspend fun applyDiscount(@Path("id") orderId: Int, @Body body: DiscountReq): JsonElement

    @retrofit2.http.Headers("X-Elevated: 1")
    @DELETE("api/orders/{id}/discount")
    suspend fun removeDiscount(@Path("id") orderId: Int): JsonElement

    @POST("api/orders/{id}/close-as-staff-meal")
    suspend fun closeStaffMeal(@Path("id") orderId: Int, @Body body: StaffMealReq): StaffMealResp

    @DELETE("api/orders/{id}")
    suspend fun deleteOrder(@Path("id") orderId: Int): JsonElement

    // Platby — idempotency key chráni pred dvojitou platbou pri timeout-retry.
    // X-Read-Timeout-Sec: Portos fiškalizácia môže presiahnuť globálnych 20 s,
    // readTimeoutInterceptor hlavičku odstráni a nastaví per-call read timeout.
    @POST("api/payments")
    suspend fun pay(
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
        @Body body: PayReq,
        @Header("X-Read-Timeout-Sec") readTimeoutSec: String = "60",
    ): PayResp

    // Zmeny — pozn.: GET /shifts/current zámerne nevoláme (vracia top-level
    // `null` čo kotlinx-serialization nezvládne); auto-open rieši POST /open.
    @GET("api/shifts/current/summary")
    suspend fun shiftSummary(): ShiftSummaryDto

    @POST("api/shifts/open")
    suspend fun shiftOpen(@Body body: OpenShiftReq): ShiftDto

    @POST("api/shifts/close")
    suspend fun shiftClose(
        @Body body: CloseShiftReq,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
    ): CloseShiftResp

    @GET("api/reports/z-report")
    suspend fun zReport(@Query("date") date: String): ZReportDto

    // Tlač
    @POST("api/print/kitchen")
    suspend fun printKitchen(@Body body: PrintKitchenReq): PrintOk

    @POST("api/print/pre-bill")
    suspend fun printPreBill(@Body body: PreBillReq): PrintOk

    @POST("api/print/paragon")
    suspend fun printParagon(@Body body: ParagonPrintReq): PrintOk

    @POST("api/print/lockcode")
    suspend fun printLockCode(@Body body: LockCodePrintReq): PrintOk

    // Paragón offline fallback — vystavenie lokálneho náhradného dokladu;
    // background worker na serveri ho po obnove Portos doregistruje.
    // X-Idempotency-Key: retry po timeoute NEvystaví duplicitný doklad.
    @POST("api/paragons")
    suspend fun issueParagon(
        @Body body: ParagonIssueReq,
        @Header("X-Idempotency-Key") idempotencyKey: String? = null,
    ): ParagonIssueResp

    // Storno kôš — dôvod storna; sklad rieši admin zo Storno page.
    @POST("api/storno-basket")
    suspend fun stornoBasket(@Body body: StornoBasketReq): JsonElement

    // TTLock — vygeneruj kód zámku (server rieši TTLock API)
    @POST("api/ttlock/passcode")
    suspend fun ttlockPasscode(@Body body: Empty): TtlockResp

    // Floor edit-mode — uloženie pozície/veľkosti stola (manazer/admin)
    @PUT("api/tables/{id}")
    suspend fun updateTable(@Path("id") id: Int, @Body body: TableUpdateReq): JsonElement

    // Auto-update (public route, číta z durable /backups/app na kase)
    @GET("api/app/latest")
    suspend fun latestVersion(): UpdateInfo

    @retrofit2.http.Streaming
    @GET
    suspend fun downloadFile(@retrofit2.http.Url url: String): okhttp3.ResponseBody
}

/* ===================== Retrofit factory ===================== */

object Api {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true   // null → default (numbers, bools)
        isLenient = true
        // encodeDefaults=true + explicitNulls=false: polia s default hodnotou SA
        // serializujú (inak by server nedostal napr. wasPrepared=true v storno
        // koši či price=0.0 pri 0 € položkách → NaN na bone), ale null-y sa
        // vynechávajú (optional version/note/… sa neposielajú zbytočne).
        encodeDefaults = true
        explicitNulls = false
    }

    // Dynamický base URL: Retrofit má placeholder host, interceptor ho prepíše
    // z AppPrefs.serverUrl (mení sa keď DHCP zmení IP — bez rebuildu Retrofit).
    private val baseSwapInterceptor = okhttp3.Interceptor { chain ->
        val target = AppPrefs.serverUrl.toHttpUrlOrNull()
        var req = chain.request()
        if (target != null) {
            val newUrl = req.url.newBuilder()
                .scheme(target.scheme)
                .host(target.host)
                .port(target.port)
                .build()
            req = req.newBuilder().url(newUrl).build()
        }
        chain.proceed(req)
    }

    // Krátkodobé povýšenie po manager PIN — verify-manager vráti elevated token
    // s krátkou platnosťou. Invariant: elevácia platí LEN pre volania označené
    // marker hlavičkou X-Elevated (storno, zľava, …), nikdy pre bežné
    // objednávky/platby — server atribuuje staffId/zmenu z JWT a bežná
    // prevádzka musí ostať pripísaná čašníkovi.
    @Volatile private var elevatedToken: String? = null
    @Volatile private var elevatedUntil: Long = 0L

    fun setElevated(token: String, ttlMs: Long = 110_000) {
        elevatedToken = token.takeIf { it.isNotBlank() }
        elevatedUntil = System.currentTimeMillis() + ttlMs
    }

    fun clearElevated() {
        elevatedToken = null
        elevatedUntil = 0L
    }

    /** Beží manažérske okno? gate() vďaka tomu nepýta PIN pri každej akcii. */
    fun isElevated(): Boolean =
        elevatedToken != null && System.currentTimeMillis() < elevatedUntil

    /** Zostávajúce ms elevácie (0 = žiadna) — pre odpočet na chipe v UI. */
    fun elevatedRemainingMs(): Long =
        if (elevatedToken == null) 0L
        else (elevatedUntil - System.currentTimeMillis()).coerceAtLeast(0L)

    // Bearer token z AppPrefs (po login-e); elevated token len pre requesty
    // s X-Elevated. Marker hlavička sa pred odoslaním VŽDY odstráni —
    // server ju nesmie vidieť.
    private val authInterceptor = okhttp3.Interceptor { chain ->
        val original = chain.request()
        val wantsElevated = original.header("X-Elevated") != null
        val elevated = if (wantsElevated && System.currentTimeMillis() < elevatedUntil) elevatedToken else null
        val t = elevated ?: AppPrefs.token
        val b = original.newBuilder().removeHeader("X-Elevated")
        if (!t.isNullOrBlank()) b.addHeader("Authorization", "Bearer $t")
        chain.proceed(b.build())
    }

    // Tichý retry LEN pre idempotentné GET-y: retryOnConnectionFailure je
    // vypnutý (tichý re-POST by mohol duplikovať doklady), ale kiosk po idle
    // bežne trafí mŕtve pooled keep-alive spojenie — prvý GET okamžite spadne
    // a UI by falošne bliklo OFFLINE. Druhý pokus ide na čerstvom spojení.
    // InterruptedIOException (timeout/cancel) sa neretryuje — zdvojnásobil by
    // čakanie a timeout nie je symptóm mŕtveho socketu.
    private val staleGetRetryInterceptor = okhttp3.Interceptor { chain ->
        val req = chain.request()
        try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val retriable = req.method.equals("GET", ignoreCase = true) &&
                e !is java.io.InterruptedIOException
            if (retriable) chain.proceed(req) else throw e
        }
    }

    // Per-call read timeout: hlavička X-Read-Timeout-Sec sa odstráni a použije
    // ako read timeout len pre daný request (pay → Portos fiškalizácia môže
    // presiahnuť globálnych 20 s).
    private val readTimeoutInterceptor = okhttp3.Interceptor { chain ->
        val req = chain.request()
        val sec = req.header("X-Read-Timeout-Sec")?.toIntOrNull()
        if (sec != null && sec > 0) {
            chain.withReadTimeout(sec, TimeUnit.SECONDS)
                .proceed(req.newBuilder().removeHeader("X-Read-Timeout-Sec").build())
        } else chain.proceed(req)
    }

    private val client = OkHttpClient.Builder()
        .addInterceptor(baseSwapInterceptor)
        .addInterceptor(authInterceptor)
        .addInterceptor(staleGetRetryInterceptor)
        .addInterceptor(readTimeoutInterceptor)
        // HTTP log len v debug builde — release nesmie sypať API prevádzku do logcatu.
        .apply { if (BuildConfig.DEBUG) addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC }) }
        // Žiadny tichý OkHttp retry — kritické retry (pay, sync) sú explicitné
        // s X-Idempotency-Key; tichý opakovaný POST by mohol duplikovať doklady.
        .retryOnConnectionFailure(false)
        // Idle sokety vyhadzuj po 60 s — TESNE pod serverový keepAliveTimeout
        // (65 s). Klient tak NIKDY nepoužije spojenie, ktoré už server zatvoril,
        // takže ani POST (login/platba) nezlyhá na mŕtvom poolovanom sokete.
        // staleGetRetryInterceptor ostáva ako poistka pre GET-y.
        .connectionPool(okhttp3.ConnectionPool(5, 60, TimeUnit.SECONDS))
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val retrofitInstance: Retrofit = Retrofit.Builder()
        .baseUrl("http://localhost/")     // placeholder — prepisuje baseSwapInterceptor
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    val service: ApiService = retrofitInstance.create(ApiService::class.java)

    /**
     * Factory pre admin obrazovky — každá si definuje vlastný malý Retrofit
     * interface + DTOs vo svojom súbore (žiadne kolízie pri paralelnom vývoji).
     * Zdieľa client (auth/base-swap interceptory) aj kotlinx Json config.
     */
    fun <T> create(cls: Class<T>): T = retrofitInstance.create(cls)
}
