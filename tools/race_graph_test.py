import unittest
from race_graph import junction_supports


class JunctionConnections(unittest.TestCase):
    def test_sloped_mouth_and_rounded_endpoint(self):
        junction = {'c': [0, 0, 10], 'ring': [[-5, -5, 9], [5, -5, 11], [5, 5, 11], [-5, 5, 9]]}
        self.assertTrue(junction_supports(junction, (5, 0), 11))
        self.assertTrue(junction_supports(junction, (5.01, 0), 11))
        self.assertFalse(junction_supports(junction, (5, 0), 7))

    def test_radius_does_not_connect_neighbouring_trail(self):
        junction = {'c': [0, 0, 10], 'ring': [[-12, -2, 10], [12, -2, 10], [12, 2, 10], [-12, 2, 10]]}
        self.assertFalse(junction_supports(junction, (0, 8), 10))
        self.assertTrue(junction_supports(junction, (12, 0), 10))


if __name__ == '__main__':
    unittest.main()
