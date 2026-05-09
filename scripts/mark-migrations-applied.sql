INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES
(1, 'users', true, decode('f3ec020a4d147d5c1dd7739ff012e85a7d5562f32132955856d89366af76037c603d7ed8a539eefc0e66f656200e6445','hex'), 0),
(2, 'api_keys', true, decode('d993188537468599cacdde48473081fd39ac97fce5d4fffb65e313f5b6a742ba4754179c6e92d33c0b1fedd3bf73473d','hex'), 0),
(3, 'jobs', true, decode('461eb0fb6eb528710fab081c4f443085673254c084aa985e501284136605559233e270c31b1fb74d31fd9f9e28795650','hex'), 0),
(4, 'token_usage', true, decode('7a42029a54cea62bd063cfabb4d61310d728f4863b15caccfaf405b949c6cabd2fa004c7f504a5fccf78aac9927541ac','hex'), 0),
(5, 'audit_log', true, decode('46add0e04cc73863092cedabe61e67f43e49b4d73b1baaaee2e6152c52349e7c36af650e57af84cfb6308b18744fdccd','hex'), 0),
(6, 'compilations', true, decode('d06de27ebd016d0ee7a91bb951adc6b45707767a554ae8b0031377d65b47a65946fc73be7aa4779be2b84ebc33f49f47','hex'), 0),
(7, 'ontologies', true, decode('f2b787c8dc8b7a0f2f8fe90e9f52a03717969f3305e006f76cf9bf9dae745af296a8b769808ed8b1c98cb73264ce4c7d','hex'), 0),
(8, 'active_learning', true, decode('953ce133964e48a1f550cf4bbcf3d1ca08c05ffec4f2ca3abacc52bb86285adaf288eedd58c435212ee00a361fc7376a','hex'), 0),
(9, 'kg_folders', true, decode('806df31f83190c88d52df1bc6932fbb072985099a95104549527062fe9bcfa33076545ae08160e9e35ac11d9daac524f','hex'), 0),
(10, 'connectors', true, decode('3e087fb089923db171827e102e3ab9090bbe8729d3acf334938accfa6dcb17175b8a06948c1436417e772921ec9049e4','hex'), 0),
(11, 'connector_configs', true, decode('b361de472202db2ccf56c404a038ce52e7cdfabe6e220c9967f8528909afa4fb37948fe226313a8258657d0ebd50befc','hex'), 0),
(12, 'job_batches', true, decode('1d1f4de13bc2c2922e6f4ac8f5581b5dee5267360e6395fc16de17b8ee2632433e13c00cd7c33a1da8f439d931405b33','hex'), 0),
(13, 'triggers', true, decode('538da22d6ffdcd2c2e37f7729709a28a97bb759aa02214b19970eb33abc60afb2b23215d02bbe86d90b6264984b79c91','hex'), 0),
(14, 'users_default_ontology', true, decode('d770fe34ed1132240f6a4206039f65c76c70e39a546df979d9bb4d4c2383b947a78197b54a38d6df9bab0acf3a47f861','hex'), 0)
ON CONFLICT (version) DO NOTHING;
