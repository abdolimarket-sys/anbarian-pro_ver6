package com.anbarian.app;

import android.app.*;
import android.content.*;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;

public class DueNotificationReceiver extends BroadcastReceiver {
    private static final String CHANNEL = "anbarin_due_reminders";
    @Override public void onReceive(Context context, Intent intent) {
        AnbarinDueStore.init(context);
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            JSONArray all = DueNotificationsPlugin.getSaved();
            long now = System.currentTimeMillis();
            JSONArray keep = new JSONArray();
            for (int i = 0; i < all.length(); i++) {
                JSONObject item = all.optJSONObject(i);
                if (item != null && item.optLong("at") > now) { keep.put(item); DueNotificationsPlugin.scheduleItem(context, item); }
            }
            DueNotificationsPlugin.save(keep);
            return;
        }
        if (!"com.anbarian.app.DUE_NOTIFICATION".equals(intent.getAction())) return;
        createChannel(context);
        int id = intent.getIntExtra("id", 1);
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        Intent openApp = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent contentIntent = openApp == null ? null : PendingIntent.getActivity(context, id, openApp, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title == null ? "یادآوری سررسید" : title)
            .setContentText(body == null ? "یک سند به سررسید رسیده است." : body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true);
        if (contentIntent != null) builder.setContentIntent(contentIntent);
        Notification notification = builder.build();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)) manager.notify(id, notification);
        context.getSharedPreferences("anbarin_due_notifications", Context.MODE_PRIVATE).edit()
            .putString("fired", context.getSharedPreferences("anbarin_due_notifications", Context.MODE_PRIVATE).getString("fired", "|") + id + "|").apply();
        JSONArray all = DueNotificationsPlugin.getSaved(); JSONArray keep = new JSONArray();
        for (int i = 0; i < all.length(); i++) { JSONObject item = all.optJSONObject(i); if (item != null && item.optInt("id") != id) keep.put(item); }
        DueNotificationsPlugin.save(keep);
    }
    private void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "یادآوری سررسید انبارین", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("اعلان سررسید فاکتورها و چک‌ها");
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }
}
