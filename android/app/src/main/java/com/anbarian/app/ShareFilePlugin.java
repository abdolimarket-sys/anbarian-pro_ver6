package com.anbarian.app;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * اشتراک‌گذاری فایل از طریق Intent.ACTION_SEND
 * تا کاربر بتواند در Google Drive، تلگرام، ایمیل و ... بفرستد.
 */
@CapacitorPlugin(name = "ShareFile")
public class ShareFilePlugin extends Plugin {

    @PluginMethod
    public void share(PluginCall call) {
        String filename = call.getString("filename", "anbarin-backup.json");
        String mimeType = call.getString("mimeType", "application/json");
        String base64 = call.getString("data", "");
        String title = call.getString("title", "اشتراک‌گذاری فایل");
        String text = call.getString("text", "");

        if (base64 == null || base64.isEmpty()) {
            call.reject("محتوای فایل خالی است");
            return;
        }

        try {
            File cacheDir = new File(getContext().getCacheDir(), "shared");
            if (!cacheDir.exists() && !cacheDir.mkdirs()) {
                call.reject("ایجاد پوشه موقت ناموفق بود");
                return;
            }
            // نام امن برای فایل موقت
            String safeName = filename.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (safeName.isEmpty()) safeName = "anbarin-share.bin";
            File outFile = new File(cacheDir, safeName);

            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(bytes);
                fos.flush();
            }

            String authority = getContext().getPackageName() + ".fileprovider";
            Uri uri = FileProvider.getUriForFile(getContext(), authority, outFile);

            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeType != null && !mimeType.isEmpty() ? mimeType : "application/octet-stream");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && !text.isEmpty()) {
                send.putExtra(Intent.EXTRA_TEXT, text);
            }
            if (title != null && !title.isEmpty()) {
                send.putExtra(Intent.EXTRA_SUBJECT, title);
            }
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(send, title != null ? title : "اشتراک‌گذاری");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            JSObject response = new JSObject();
            response.put("shared", true);
            response.put("filename", safeName);
            call.resolve(response);
        } catch (IOException e) {
            call.reject("نوشتن فایل موقت ناموفق بود: " + e.getMessage(), e);
        } catch (Exception e) {
            call.reject("اشتراک‌گذاری ناموفق بود: " + e.getMessage(), e);
        }
    }
}
