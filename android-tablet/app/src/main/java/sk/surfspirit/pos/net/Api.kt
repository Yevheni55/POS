package sk.surfspirit.pos.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import sk.surfspirit.pos.core.AppPrefs
import java.util.concurrent.TimeUnit

/* ===================== DTOs (zhoda s /api shape) ===================== */

@Serializable data class LoginReq(val pin: String)
@Serializable data class UserDto(val id: Int, val name: String, val role: String)
@Serializable data class LoginResp(val token: String, val user: UserDto)

@Serializable data class TableDto(
    val id: Int,
    val name: String = "",
    val seats: Int = 4,
    val zone: String = "interior",
    val shape: String = "rect",
    val status: String = "free",          // free | occupied | reserved | dirty
)

@Serializable data class MenuItemDto(
    val id: Int,
    val name: String = "",
    val emoji: String = "",
    val price: Double = 0.0,
    val categoryId: Int = 0,
    val active: Boolean = true,
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
)

@Serializable data class OrderDto(
    val id: Int,
    val tableId: Int = 0,
    val label: String = "",
    val total: Double = 0.0,
    val totalAfterDiscount: Double = 0.0,
    val items: List<OrderItemDto> = emptyList(),
)

@Serializable data class NewItem(val menuItemId: Int, val qty: Int, val note: String = "")
@Serializable data class CreateOrderReq(val tableId: Int, val items: List<NewItem>)
@Serializable data class AddItemsReq(val items: List<NewItem>)
@Serializable data class SendReq(val overrideLimit: Boolean = false)
@Serializable class Empty   // ignoreUnknownKeys → pohltí ľubovoľnú odpoveď

/* ===================== API service ===================== */

interface ApiService {
    @POST("api/auth/login")
    suspend fun login(@Body body: LoginReq): LoginResp

    @GET("api/tables")
    suspend fun tables(): List<TableDto>

    @GET("api/menu")
    suspend fun menu(): List<CategoryDto>

    @GET("api/orders/table/{id}")
    suspend fun tableOrders(@Path("id") tableId: Int): List<OrderDto>

    @POST("api/orders")
    suspend fun createOrder(@Body body: CreateOrderReq): OrderDto

    @POST("api/orders/{id}/items")
    suspend fun addItems(@Path("id") orderId: Int, @Body body: AddItemsReq): Empty

    @POST("api/orders/{id}/send-and-print")
    suspend fun sendAndPrint(@Path("id") orderId: Int, @Body body: SendReq): Empty
}

/* ===================== Retrofit factory ===================== */

object Api {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true   // null → default (numbers, bools)
        isLenient = true
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

    // Bearer token z AppPrefs (po login-e).
    private val authInterceptor = okhttp3.Interceptor { chain ->
        val t = AppPrefs.token
        val req = if (!t.isNullOrBlank())
            chain.request().newBuilder().addHeader("Authorization", "Bearer $t").build()
        else chain.request()
        chain.proceed(req)
    }

    private val client = OkHttpClient.Builder()
        .addInterceptor(baseSwapInterceptor)
        .addInterceptor(authInterceptor)
        .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    val service: ApiService = Retrofit.Builder()
        .baseUrl("http://localhost/")     // placeholder — prepisuje baseSwapInterceptor
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(ApiService::class.java)
}
