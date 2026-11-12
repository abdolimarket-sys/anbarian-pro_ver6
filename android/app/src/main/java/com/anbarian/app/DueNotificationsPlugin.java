package com.anbarian.app;

import android.Manifest;
import android.os.Build;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "DueNotifications", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class DueNotificationsPlugin extends Plugin {
    private static final String PREFS = "anbarin_due_notifications";

    @Override public void load() { AnbarinDueStore.init(getContext()); }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            JSObject ret = new JSObject(); ret.put("granted", true); call.resolve(ret); return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        int id = call.getInt("id", 0);
        long at = call.getLong("at", 0L);
        String title = call.getString("title", "یادآوری سررسید");
        String body = call.getString("body", "یک سند به سررسید رسیده است.");
        if (id == 0 || at <= System.currentTimeMillis()) { call.reject("شناسه یا زمان اعلان معتبر نیست"); return; }
        try {
            String fired = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("fired", "|");
            if (fired.contains("|" + id + "|")) { JSObject ret = new JSObject(); ret.put("scheduled", false); ret.put("alreadyFired", true); call.resolve(ret); return; }
            JSONObject item = new JSONObject(); item.put("id", id); item.put("at", at); item.put("title", title); item.put("body", body);
            JSONArray all = getSaved();
            JSONArray next = new JSONArray();
            for (int i = 0; i < all.length(); i++) if (all.getJSONObject(i).optInt("id") != id) next.put(all.getJSONObject(i));
            next.put(item); save(next); scheduleItem(getContext(), item);
            JSObject ret = new JSObject(); ret.put("scheduled", true); call.resolve(ret);
        } catch (Exception e) { call.reject("زمان‌بندی اعلان ناموفق بود", e); }
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        try {
            JSONArray all = getSaved();
            for (int i = 0; i < all.length(); i++) cancelItem(getContext(), all.getJSONObject(i).optInt("id"));
            save(new JSONArray());
            JSObject ret = new JSObject(); ret.put("cancelled", true); call.resolve(ret);
        } catch (Exception e) { call.reject("لغو اعلان‌ها ناموفق بود", e); }
    }

    static JSONArray getSaved() {
        String raw = com.anbarian.app.AnbarinDueStore.read();
        try { return new JSONArray(raw); } catch (Exception e) { return new JSONArray(); }
    }
    static void save(JSONArray items) { com.anbarian.app.AnbarinDueStore.write(items.toString()); }

    static void scheduleItem(Context context, JSONObject item) {
        int id = item.optInt("id");
        Intent intent = new Intent(context, DueNotificationReceiver.class).setAction("com.anbarian.app.DUE_NOTIFICATION");
        intent.putExtra("id", id); intent.putExtra("title", item.optString("title")); intent.putExtra("body", item.optString("body"));
        PendingIntent pi = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        AlarmManager alarm = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarm != null) {
            if (Build.VERSION.SDK_INT >= 23) alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.optLong("at"), pi);
            else alarm.set(AlarmManager.RTC_WAKEUP, item.optLong("at"), pi);
        }
    }
    static void cancelItem(Context context, int id) {
        Intent intent = new Intent(context, DueNotificationReceiver.class).setAction("com.anbarian.app.DUE_NOTIFICATION");
        PendingIntent pi = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_NO_CREATE | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        if (pi != null) { AlarmManager alarm = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE); if (alarm != null) alarm.cancel(pi); pi.cancel(); }
    }
}
