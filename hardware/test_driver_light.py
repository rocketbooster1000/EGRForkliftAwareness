import http.client
import json
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from driver_light import DriverLight
from pi_bridge import StreamState, make_handler, measurement, parse_args


class Output:
    def __init__(self): self.lit = False
    def on(self): self.lit = True
    def off(self): self.lit = False
    def close(self): self.off()


class LightTests(unittest.TestCase):
    def setUp(self):
        self.now = 10
        self.state = StreamState()
        self.output = Output()
        self.light = DriverLight(self.state, self.output, lambda: self.now)
        self.publish(80)

    def publish(self, cm):
        self.state.publish(measurement('boom', cm, 4), b'jpeg')

    def test_threshold_hysteresis_and_flash_timing(self):
        self.light.configure({'enabled': True, 'threshold_m': 1})
        self.assertTrue(self.output.lit)
        self.now += .3; self.light.tick(); self.assertFalse(self.output.lit)
        self.now += .25; self.light.tick(); self.assertTrue(self.output.lit)
        self.publish(103); self.light.tick(); self.assertTrue(self.light.active)
        self.publish(106); self.light.tick(); self.assertFalse(self.light.active)
        self.publish(102); self.light.tick(); self.assertFalse(self.light.active)
        self.publish(100); self.light.tick(); self.assertTrue(self.light.active)

    def test_invalid_stale_failed_and_saturated_readings_clear_output(self):
        self.light.configure({'enabled': True, 'threshold_m': 4.5})
        for value in (None, 400, -1):
            self.publish(value); self.light.tick()
            self.assertFalse(self.output.lit)
            self.assertEqual(self.light.reason, 'sensor_unavailable')
        self.publish(50); self.state.updated -= 4; self.light.tick()
        self.assertFalse(self.light.active)
        self.publish(50); self.state.fail('camera stopped'); self.light.tick()
        self.assertFalse(self.light.active)

    def test_test_expires_disable_shutdown_and_validation(self):
        self.light.test(); self.assertTrue(self.output.lit)
        self.now += 2.1; self.light.tick(); self.assertFalse(self.light.active)
        self.light.configure({'enabled': True, 'threshold_m': 1})
        self.light.configure({'enabled': False, 'threshold_m': 1})
        self.assertFalse(self.output.lit)
        for value in ({}, {'enabled': 1, 'threshold_m': 1}, {'enabled': True, 'threshold_m': float('nan')}, {'enabled': True, 'threshold_m': 5}):
            with self.assertRaises(ValueError): self.light.configure(value)
        self.light.test(); self.light.close(); self.assertFalse(self.output.lit)
        self.assertIsNone(parse_args([]).light_pin)
        with self.assertRaises(SystemExit): parse_args(['--light-pin','17'])

    def test_http_mutations_require_bearer_origin_and_valid_json(self):
        token = 'fixture-light-key'
        server = ThreadingHTTPServer(('127.0.0.1',0), make_handler(self.state, Path('.'), token, ['http://localhost:4317'], self.light))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(path, body, headers):
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            connection.request('POST', path, json.dumps(body), {'Content-Type':'application/json', **headers})
            response = connection.getresponse(); result = response.status, json.loads(response.read()); connection.close(); return result
        try:
            body = {'enabled':True, 'threshold_m':1}
            self.assertEqual(request('/api/light?key='+token, body, {})[0],401)
            auth = {'Authorization':'Bearer '+token}
            self.assertEqual(request('/api/light',body,{**auth,'Origin':'https://bad.example'})[0],403)
            self.assertEqual(request('/api/light',{},auth)[0],400)
            code, data = request('/api/light',body,{**auth,'Origin':'http://localhost:4317'})
            self.assertEqual(code,200); self.assertTrue(data['enabled']); self.assertTrue(data['active'])
            self.assertEqual(request('/api/light/test',{},auth)[1]['reason'],'testing')
        finally:
            server.shutdown(); server.server_close(); thread.join(3)

if __name__ == '__main__': unittest.main()
