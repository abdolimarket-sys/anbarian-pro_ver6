package com.anbarian.app;

import android.app.Activity;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executor;

/** احراز هویت بیومتریک دستگاه (اثرانگشت / چهره / قفل صفحه) */
@CapacitorPlugin(name = "BiometricAuth")
public class BiometricPlugin extends Plugin {

    @PluginMethod
    public void isAvailable(PluginCall call) {
        BiometricManager mgr = BiometricManager.from(getContext());
        int can = mgr.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.BIOMETRIC_WEAK
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL
        );
        JSObject res = new JSObject();
        boolean ok = can == BiometricManager.BIOMETRIC_SUCCESS;
        res.put("available", ok);
        res.put("code", can);
        String reason = "unavailable";
        if (can == BiometricManager.BIOMETRIC_SUCCESS) reason = "ready";
        else if (can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) reason = "none_enrolled";
        else if (can == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE) reason = "no_hardware";
        else if (can == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) reason = "hw_unavailable";
        res.put("reason", reason);
        call.resolve(res);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String title = call.getString("title", "ورود به انبارین");
        String subtitle = call.getString("subtitle", "با اثرانگشت، چهره یا رمز قفل صفحه تأیید کنید");

        Activity raw = getActivity();
        if (!(raw instanceof FragmentActivity)) {
            call.reject("فعالیت برنامه برای بیومتریک آماده نیست");
            return;
        }
        final FragmentActivity activity = (FragmentActivity) raw;
        final String finalTitle = title != null ? title : "ورود به انبارین";
        final String finalSubtitle = subtitle;

        activity.runOnUiThread(() -> {
            try {
                Executor executor = ContextCompat.getMainExecutor(activity);
                BiometricPrompt prompt = new BiometricPrompt(
                    activity,
                    executor,
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                            JSObject res = new JSObject();
                            res.put("ok", true);
                            call.resolve(res);
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                            if (errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                || errorCode == BiometricPrompt.ERROR_USER_CANCELED
                                || errorCode == BiometricPrompt.ERROR_CANCELED) {
                                JSObject res = new JSObject();
                                res.put("ok", false);
                                res.put("cancelled", true);
                                call.resolve(res);
                                return;
                            }
                            call.reject(errString != null ? errString.toString() : "احراز هویت ناموفق");
                        }

                        @Override
                        public void onAuthenticationFailed() {
                        }
                    }
                );

                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(finalTitle)
                    .setSubtitle(finalSubtitle)
                    .setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG
                            | BiometricManager.Authenticators.BIOMETRIC_WEAK
                            | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                    )
                    .build();
                prompt.authenticate(info);
            } catch (Exception e) {
                call.reject("بیومتریک در دسترس نیست: " + e.getMessage(), e);
            }
        });
    }
}
