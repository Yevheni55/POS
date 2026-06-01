# kotlinx-serialization — ponechať @Serializable metadata
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class sk.surfspirit.pos.** {
    *** Companion;
}
-keep,includedescriptorclasses class sk.surfspirit.pos.**$$serializer { *; }
