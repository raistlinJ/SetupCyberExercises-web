import unittest
from pathlib import Path


class MediaManagerPersistenceRegressionTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.app_source = (root / "app/static/js/app.js").read_text(encoding="utf-8")
        cls.ctfd_source = (root / "app/static/js/ctfd_manager.js").read_text(encoding="utf-8")

    def test_mutations_require_fresh_store_when_legacy_replacement_is_unavoidable(self):
        self.assertIn("if (opts.requireFresh) throw err;", self.app_source)
        self.assertGreaterEqual(self.app_source.count("requireFresh: true"), 4)

    def test_media_enable_uses_partial_patch_instead_of_full_store_replacement(self):
        start = self.app_source.index("async function mediaManagerSetItemsEnabled")
        end = self.app_source.index("async function mediaManagerUploadFilesBatch", start)
        function_source = self.app_source[start:end]
        self.assertIn("patchProjectAudio(pid, audioPatch)", function_source)
        self.assertNotIn("saveProjectAudio(pid, audioStore)", function_source)

    def test_ctfd_multi_save_patches_each_project_independently(self):
        start = self.ctfd_source.index("async function ctfdSaveNotifyConfig")
        end = self.ctfd_source.index("// Generic Confirmation Modal Utility", start)
        function_source = self.ctfd_source[start:end]
        self.assertIn("patchProjectAudio(savePid, audioPatch", function_source)
        self.assertIn("loadProjectAudio(savePid", function_source)
        self.assertNotIn("saveProjectAudio(savePid, audioStore)", function_source)

    def test_media_list_ignores_stale_project_responses_and_tracks_selection(self):
        start = self.app_source.index("async function mediaManagerRefreshList")
        end = self.app_source.index("function wireMediaManagerControls", start)
        refresh_source = self.app_source[start:end]
        self.assertIn("refreshToken !== MEDIA_MANAGER_REFRESH_TOKEN", refresh_source)
        self.assertIn("mediaManagerReadCurrentPid() !== pid", refresh_source)
        self.assertIn("document.addEventListener('project-selected'", self.app_source)


if __name__ == "__main__":
    unittest.main()
