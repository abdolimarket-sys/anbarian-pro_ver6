package com.anbarian.app;
import android.content.Context;
public final class AnbarinDueStore {
    private static Context context;
    static void init(Context c) { context = c.getApplicationContext(); }
    static String read() { return context == null ? "[]" : context.getSharedPreferences("anbarin_due_notifications", Context.MODE_PRIVATE).getString("items", "[]"); }
    static void write(String value) { if (context != null) context.getSharedPreferences("anbarin_due_notifications", Context.MODE_PRIVATE).edit().putString("items", value).apply(); }
}
