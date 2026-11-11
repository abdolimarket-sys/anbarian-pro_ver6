package com.anbarian.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * پشتیبان خودکار:
 * - پیش‌فرض: Documents/AnbarinBackups
 * - اختیاری: پوشه انتخابی کاربر (SAF tree URI با مجوز پایدار)
 */
@CapacitorPlugin(name = "AutoBackup")
public class AutoBackupPlugin extends Plugin {
    private static final String FOLDER = "AnbarinBackups";
    private static final String PREFS = "anbarin_auto_backup";
    private static final String KEY_TREE = "tree_uri";
    private static final int KEEP = 8;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private Uri customTreeUri() {
        String raw = prefs().getString(KEY_TREE, null);
        if (raw == null || raw.isEmpty()) return null;
        try { return Uri.parse(raw); } catch (Exception e) { return null; }
    }

    /** تشخیص اینکه URI مربوط به Google Drive هست یا نه */
    private boolean looksLikeDrive(Uri uri) {
        if (uri == null) return false;
        String authority = uri.getAuthority();
        if (authority != null) {
            String a = authority.toLowerCase();
            if (a.contains("com.google.android.apps.docs") ||
                a.contains("com.google.android.apps.docs.storage") ||
                a.startsWith("com.google.android.apps.docs")) {
                return true;
            }
        }
        String s = uri.toString().toLowerCase();
        return s.contains("com.google.android.apps.docs");
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject res = new JSObject();
        Uri tree = customTreeUri();
        if (tree != null) {
            res.put("mode", "custom");
            res.put("uri", tree.toString());
            res.put("isDrive", looksLikeDrive(tree));
            String label = tree.toString();
            try {
                DocumentFile df = DocumentFile.fromTreeUri(getContext(), tree);
                if (df != null && df.getName() != null) label = df.getName();
            } catch (Exception ignored) {}
            if (looksLikeDrive(tree) && (label == null || label.isEmpty() || label.startsWith("content:"))) {
                label = "Google Drive";
            }
            res.put("label", label);
            res.put("defaultPath", Environment.DIRECTORY_DOCUMENTS + "/" + FOLDER);
        } else {
            res.put("mode", "default");
            res.put("uri", "");
            res.put("isDrive", false);
            res.put("label", Environment.DIRECTORY_DOCUMENTS + "/" + FOLDER);
            res.put("defaultPath", Environment.DIRECTORY_DOCUMENTS + "/" + FOLDER);
        }
        call.resolve(res);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Uri driveRoot = Uri.parse("content://com.google.android.apps.docs.storage/document/root");
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, driveRoot);
            } catch (Exception ignored) {}
        }
        if (call.getBoolean("preferDrive", false)) {
            try { intent.putExtra("android.content.extra.SHOW_ADVANCED", true); } catch (Exception ignored) {}
        }
        startActivityForResult(call, intent, "handlePickFolder");
    }

    @ActivityCallback
    private void handlePickFolder(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Uri tree = result.getData().getData();
        if (tree == null) {
            call.reject("پوشه‌ای انتخاب نشد");
            return;
        }
        try {
            final int takeFlags = result.getData().getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContext().getContentResolver().takePersistableUriPermission(tree, takeFlags);
        } catch (Exception e) {
            // بعضی ارائه‌دهنده‌ها persist را محدود می‌کنند؛ باز هم مسیر را نگه می‌داریم
        }
        prefs().edit().putString(KEY_TREE, tree.toString()).apply();
        JSObject res = new JSObject();
        res.put("cancelled", false);
        res.put("mode", "custom");
        res.put("uri", tree.toString());
        res.put("isDrive", looksLikeDrive(tree));
        String label = tree.toString();
        try {
            DocumentFile df = DocumentFile.fromTreeUri(getContext(), tree);
            if (df != null && df.getName() != null) label = df.getName();
        } catch (Exception ignored) {}
        if (looksLikeDrive(tree) && (label == null || label.isEmpty() || label.startsWith("content:"))) {
            label = "Google Drive";
        }
        res.put("label", label);
        call.resolve(res);
    }

    @PluginMethod
    public void clearFolder(PluginCall call) {
        Uri tree = customTreeUri();
        if (tree != null) {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(
                    tree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
            } catch (Exception ignored) {}
        }
        prefs().edit().remove(KEY_TREE).apply();
        JSObject res = new JSObject();
        res.put("mode", "default");
        res.put("label", Environment.DIRECTORY_DOCUMENTS + "/" + FOLDER);
        call.resolve(res);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String filename = call.getString("filename", "anbarin-auto.json");
        String base64 = call.getString("data", "");
        if (base64 == null || base64.isEmpty()) {
            call.reject("محتوای پشتیبان خالی است");
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String safe = filename.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (!safe.endsWith(".json")) safe = safe + ".json";

            Uri tree = customTreeUri();
            Uri writtenUri;
            if (tree != null) {
                writtenUri = writeToTree(tree, safe, bytes);
            } else {
                writtenUri = writeToDefault(safe, bytes);
            }
            pruneOldBackups();

            JSObject res = new JSObject();
            res.put("ok", true);
            res.put("filename", safe);
            res.put("uri", writtenUri != null ? writtenUri.toString() : "");
            res.put("mode", tree != null ? "custom" : "default");
            call.resolve(res);
        } catch (Exception e) {
            call.reject("نوشتن پشتیبان خودکار ناموفق: " + e.getMessage(), e);
        }
    }

    private Uri writeToTree(Uri tree, String safe, byte[] bytes) throws Exception {
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        if (root == null || !root.canWrite()) {
            // مجوز از دست رفته → بازگشت به پیش‌فرض
            prefs().edit().remove(KEY_TREE).apply();
            return writeToDefault(safe, bytes);
        }
        DocumentFile existing = root.findFile(safe);
        if (existing != null) existing.delete();
        // createFile گاهی پسوند را تکرار می‌کند؛ نام بدون .json و mime جدا
        String baseName = safe.endsWith(".json") ? safe.substring(0, safe.length() - 5) : safe;
        DocumentFile file = root.createFile("application/json", baseName);
        if (file == null) throw new Exception("ایجاد فایل در پوشه انتخابی ناموفق بود");
        try (OutputStream out = getContext().getContentResolver().openOutputStream(file.getUri(), "w")) {
            if (out == null) throw new Exception("خروجی فایل در دسترس نیست");
            out.write(bytes);
            out.flush();
        }
        return file.getUri();
    }

    private Uri writeToDefault(String safe, byte[] bytes) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            try {
                String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?";
                resolver.delete(MediaStore.Files.getContentUri("external"), sel, new String[]{safe, "%" + FOLDER + "%"});
            } catch (Exception ignored) {}
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/" + FOLDER);
            Uri uri = resolver.insert(MediaStore.Files.getContentUri("external"), values);
            if (uri == null) throw new Exception("ایجاد فایل MediaStore ناموفق بود");
            try (OutputStream out = resolver.openOutputStream(uri, "w")) {
                if (out == null) throw new Exception("خروجی فایل در دسترس نیست");
                out.write(bytes);
                out.flush();
            }
            return uri;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), FOLDER);
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("ایجاد پوشه پشتیبان ناموفق بود");
        File file = new File(dir, safe);
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(bytes);
            out.flush();
        }
        return Uri.fromFile(file);
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            JSArray files = new JSArray();
            Uri tree = customTreeUri();
            if (tree != null) {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
                if (root != null) {
                    DocumentFile[] children = root.listFiles();
                    Arrays.sort(children, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                    for (DocumentFile f : children) {
                        if (f == null || !f.isFile()) continue;
                        String n = f.getName();
                        if (n == null || !n.endsWith(".json")) continue;
                        JSObject item = new JSObject();
                        item.put("name", n);
                        item.put("size", f.length());
                        item.put("modified", f.lastModified());
                        files.put(item);
                    }
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                String[] proj = new String[]{
                    MediaStore.MediaColumns.DISPLAY_NAME,
                    MediaStore.MediaColumns.SIZE,
                    MediaStore.MediaColumns.DATE_MODIFIED,
                    MediaStore.MediaColumns._ID
                };
                String sel = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
                try (Cursor c = resolver.query(MediaStore.Files.getContentUri("external"), proj, sel,
                        new String[]{"%" + FOLDER + "%", "%.json"}, MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
                    if (c != null) {
                        while (c.moveToNext()) {
                            JSObject item = new JSObject();
                            item.put("name", c.getString(0));
                            item.put("size", c.getLong(1));
                            item.put("modified", c.getLong(2) * 1000L);
                            item.put("id", c.getLong(3));
                            files.put(item);
                        }
                    }
                }
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), FOLDER);
                File[] list = dir.exists() ? dir.listFiles((d, n) -> n.endsWith(".json")) : null;
                if (list != null) {
                    Arrays.sort(list, Comparator.comparingLong(File::lastModified).reversed());
                    for (File f : list) {
                        JSObject item = new JSObject();
                        item.put("name", f.getName());
                        item.put("size", f.length());
                        item.put("modified", f.lastModified());
                        item.put("path", f.getAbsolutePath());
                        files.put(item);
                    }
                }
            }
            JSObject res = new JSObject();
            res.put("files", files);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("فهرست پشتیبان‌ها ناموفق: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("نام فایل مشخص نیست");
            return;
        }
        try {
            byte[] bytes = null;
            Uri tree = customTreeUri();
            if (tree != null) {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
                if (root != null) {
                    DocumentFile f = root.findFile(name);
                    if (f != null && f.exists()) {
                        try (InputStream in = getContext().getContentResolver().openInputStream(f.getUri())) {
                            if (in != null) bytes = readAll(in);
                        }
                    }
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?";
                try (Cursor c = resolver.query(MediaStore.Files.getContentUri("external"),
                        new String[]{MediaStore.MediaColumns._ID}, sel, new String[]{name, "%" + FOLDER + "%"}, null)) {
                    if (c != null && c.moveToFirst()) {
                        long id = c.getLong(0);
                        Uri uri = Uri.withAppendedPath(MediaStore.Files.getContentUri("external"), String.valueOf(id));
                        try (InputStream in = resolver.openInputStream(uri)) {
                            if (in != null) bytes = readAll(in);
                        }
                    }
                }
            } else {
                File file = new File(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), FOLDER), name);
                if (file.exists()) {
                    try (FileInputStream in = new FileInputStream(file)) {
                        bytes = readAll(in);
                    }
                }
            }
            if (bytes == null) {
                call.reject("فایل پشتیبان پیدا نشد");
                return;
            }
            JSObject res = new JSObject();
            res.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            res.put("name", name);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("خواندن پشتیبان ناموفق: " + e.getMessage(), e);
        }
    }

    private void pruneOldBackups() {
        try {
            Uri tree = customTreeUri();
            if (tree != null) {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
                if (root == null) return;
                List<DocumentFile> autos = new ArrayList<>();
                for (DocumentFile f : root.listFiles()) {
                    if (f != null && f.isFile()) {
                        String n = f.getName();
                        if (n != null && n.startsWith("anbarin-auto") && n.endsWith(".json")) autos.add(f);
                    }
                }
                autos.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                for (int i = KEEP; i < autos.size(); i++) {
                    try { autos.get(i).delete(); } catch (Exception ignored) {}
                }
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                List<long[]> rows = new ArrayList<>();
                String sel = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
                try (Cursor c = resolver.query(MediaStore.Files.getContentUri("external"),
                        new String[]{MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_MODIFIED},
                        sel, new String[]{"%" + FOLDER + "%", "anbarin-auto%"}, MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
                    if (c != null) {
                        while (c.moveToNext()) rows.add(new long[]{c.getLong(0), c.getLong(1)});
                    }
                }
                for (int i = KEEP; i < rows.size(); i++) {
                    Uri uri = Uri.withAppendedPath(MediaStore.Files.getContentUri("external"), String.valueOf(rows.get(i)[0]));
                    try { resolver.delete(uri, null, null); } catch (Exception ignored) {}
                }
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), FOLDER);
                File[] list = dir.exists() ? dir.listFiles((d, n) -> n.startsWith("anbarin-auto") && n.endsWith(".json")) : null;
                if (list == null || list.length <= KEEP) return;
                Arrays.sort(list, Comparator.comparingLong(File::lastModified).reversed());
                for (int i = KEEP; i < list.length; i++) {
                    //noinspection ResultOfMethodCallIgnored
                    list[i].delete();
                }
            }
        } catch (Exception ignored) {}
    }

    private static byte[] readAll(InputStream in) throws Exception {
        byte[] buffer = new byte[8192];
        int n;
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        while ((n = in.read(buffer)) != -1) bos.write(buffer, 0, n);
        return bos.toByteArray();
    }
}
