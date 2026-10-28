package devemu.probe;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;

// 以 adb shell 身份订阅真实 Android API；不安装 APK，不注册 mock provider。
public class LocationProbe {
  public static void main(String[] args) throws Exception {
    Looper.prepare();
    Class<?> threadClass = Class.forName("android.app.ActivityThread");
    Object thread = threadClass.getMethod("systemMain").invoke(null);
    Context system = (Context) threadClass.getMethod("getSystemContext").invoke(thread);
    Context context = system.createPackageContext("com.android.shell", 0);
    LocationManager locations = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
    SensorManager sensors = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
    JSONArray fixes = new JSONArray();
    Map<Integer, Integer> counts = new HashMap<>();
    Map<Integer, Float> minimum = new HashMap<>();
    Map<Integer, Float> maximum = new HashMap<>();
    LocationListener listener = new LocationListener() {
      public void onLocationChanged(Location location) {
        try {
          JSONObject fix = new JSONObject();
          fix.put("lat", location.getLatitude()); fix.put("lon", location.getLongitude());
          fix.put("speed", location.getSpeed()); fix.put("bearing", location.getBearing());
          fix.put("altitude", location.getAltitude()); fix.put("mock", location.isFromMockProvider());
          fixes.put(fix);
        } catch (Exception e) { throw new RuntimeException(e); }
      }
      public void onProviderEnabled(String provider) {}
      public void onProviderDisabled(String provider) {}
      public void onStatusChanged(String provider, int status, Bundle extras) {}
    };
    locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, listener);
    SensorEventListener sensorListener = new SensorEventListener() {
      public void onAccuracyChanged(Sensor sensor, int accuracy) {}
      public void onSensorChanged(SensorEvent event) {
        int type = event.sensor.getType();
        counts.put(type, counts.getOrDefault(type, 0) + 1);
        float value = event.values[type == Sensor.TYPE_ACCELEROMETER ? 1 : 0];
        minimum.put(type, Math.min(minimum.getOrDefault(type, Float.POSITIVE_INFINITY), value));
        maximum.put(type, Math.max(maximum.getOrDefault(type, Float.NEGATIVE_INFINITY), value));
      }
    };
    int[] types = {Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GYROSCOPE, Sensor.TYPE_MAGNETIC_FIELD, Sensor.TYPE_PRESSURE, Sensor.TYPE_STEP_COUNTER};
    for (int type : types) {
      Sensor sensor = sensors.getDefaultSensor(type);
      if (sensor != null) sensors.registerListener(sensorListener, sensor, 50000);
    }
    System.out.println("PROBE_READY");
    new Handler(Looper.myLooper()).postDelayed(() -> {
      try {
        JSONObject result = new JSONObject(); result.put("fixes", fixes);
        JSONArray readings = new JSONArray();
        for (int type : types) {
          JSONObject reading = new JSONObject(); reading.put("type", type);
          reading.put("available", sensors.getDefaultSensor(type) != null);
          reading.put("samples", counts.getOrDefault(type, 0));
          if (minimum.containsKey(type)) { reading.put("min", minimum.get(type)); reading.put("max", maximum.get(type)); }
          readings.put(reading);
        }
        result.put("sensors", readings);
        System.out.println("PROBE_RESULT " + result);
      } catch (Exception e) { e.printStackTrace(); }
      locations.removeUpdates(listener); sensors.unregisterListener(sensorListener);
      Looper.myLooper().quit();
    }, 7000);
    Looper.loop();
  }
}
